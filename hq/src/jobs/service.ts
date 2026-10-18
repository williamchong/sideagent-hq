import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentRole,
  BalanceOutput,
  ClaimJobOutput,
  CodeFile,
  JobEvent,
  JobSpec,
  JobState,
  JobStatus,
  JobSummary,
  JobType,
  ListJobsInput,
  ListJobsOutput,
  Submission,
  SubmitResultOutput,
} from "@sideagent/protocol";
import { codename } from "@sideagent/protocol";
import { Timestamp, type DocumentData, type Firestore } from "firebase-admin/firestore";
import { getJson, getText, putJson } from "../adapters/blob/helpers.ts";
import type { BlobStore } from "../adapters/blob/types.ts";
import type { PipelineRunner, PipelineStep } from "../adapters/pipeline/types.ts";
import { restore } from "../adapters/redactor/redact.ts";
import type { Vault } from "../adapters/vault/types.ts";
import type { Config } from "../config.ts";
import { HqError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";
import type { Limits } from "../limits.ts";
import {
  accounts,
  balanceInTx,
  balanceOf,
  requireCredits,
  stakeFor,
  transfer,
} from "../ledger/ledger.ts";
import type { Agent } from "../store/agents.ts";
import {
  appendEvent,
  CLAIM_HELD_STATES,
  claimExpired,
  expireClaimIfDue,
  expireJobIfDue,
  jobNotFound,
  jobRef,
  toSummary,
  updateJob,
  type JobDoc,
} from "../store/jobs.ts";
import { loadPlaceholders } from "../store/vault.ts";

const BOARD_STATES: readonly JobState[] = ["open", ...CLAIM_HELD_STATES];
const BOARD_LIMIT = 50;
const POLL_INTERVAL_MS = 1000;

/** The pipeline step that moves a job on from each pre-board state. Steps are idempotent. */
const PENDING_STEP: Partial<Record<JobState, PipelineStep>> = {
  draft: "screen",
  screening: "screen",
  test_review: "review",
  open: "dispatch",
};

export interface JobServiceDeps {
  db: Firestore;
  blobs: BlobStore;
  pipeline: PipelineRunner;
  vault: Vault;
  limits: Limits;
  config: Pick<
    Config,
    | "CLAIM_TTL_SECONDS"
    | "CLAIM_ATTEMPTS"
    | "STAKE_PERCENT"
    | "TIMEOUT_SLASH_PERCENT"
    | "SCREENING_FEE"
    | "LIMIT_CHECKS_PER_JOB"
  >;
  now?: () => Date;
}

export type JobService = ReturnType<typeof createJobService>;

/** Business logic behind both REST and MCP. Transport code only parses input and calls these. */
export function createJobService({
  db,
  blobs,
  pipeline,
  vault,
  limits,
  config,
  now = () => new Date(),
}: JobServiceDeps) {
  async function postJob(agent: Agent, input: JobSpec): Promise<JobSummary> {
    requireRole(agent, "poster");
    const at = now();
    if (Date.parse(input.deadline) <= at.getTime()) {
      throw new HqError("invalid_request", "deadline is in the past", "Set a future deadline");
    }
    const jobId = deterministicId("job", agent.id, input.idempotency_key);
    const requestHash = hashJson(input);
    const ref = jobRef(db, jobId);

    const existing = await ref.get();
    if (existing.exists) return replayJob(jobId, existing.data() as JobDoc, requestHash);
    await limits.requireRunning();

    // Blob keys derive from the job ID, so a retry after a partial failure overwrites them.
    const specRef = `jobs/${jobId}/spec.md`;
    const [, hiddenTestsRef, referenceSolutionRef] = await Promise.all([
      blobs.put(specRef, input.spec),
      input.hidden_tests
        ? putJson(blobs, `jobs/${jobId}/hidden_tests.json`, input.hidden_tests)
        : null,
      input.reference_solution
        ? putJson(blobs, `jobs/${jobId}/reference_solution.json`, input.reference_solution)
        : null,
    ]);

    const ownerAccount = accounts.owner(agent.ownerId);
    const summary = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return replayJob(jobId, snap.data() as JobDoc, requestHash);
      const fee = config.SCREENING_FEE;
      requireCredits(
        await balanceInTx(tx, db, ownerAccount),
        input.budget + fee,
        fee ? `This job's budget plus the ${fee}-credit screening fee` : "This job's budget",
      );
      // The transaction's last read; writes follow.
      await limits.reservePost(tx, agent.ownerId, at);
      const ts = Timestamp.fromDate(at);
      const job: JobDoc = {
        posterAgentId: agent.id,
        posterOwnerId: agent.ownerId,
        type: input.type,
        runtime: input.runtime ?? null,
        title: input.title,
        state: "draft",
        specRef,
        publicTests: input.public_tests,
        budget: input.budget,
        screeningFee: fee,
        deadline: Timestamp.fromDate(new Date(input.deadline)),
        claim: null,
        passedSubmissionId: null,
        lastCheck: null,
        idempotencyKey: input.idempotency_key,
        requestHash,
        eventSeq: 0,
        createdAt: ts,
        updatedAt: ts,
      };
      appendEvent(tx, ref, job, null, "draft", "Briefing filed", ts);
      tx.create(ref, job);
      tx.create(ref.collection("private").doc("main"), { hiddenTestsRef, referenceSolutionRef });
      transfer(
        tx,
        db,
        {
          from: ownerAccount,
          to: accounts.escrow(jobId),
          amount: input.budget + fee,
          jobId,
          reason: fee ? "Budget and screening fee held in escrow" : "Budget held in escrow",
        },
        ts,
      );
      return toSummary(jobId, job);
    });
    // Idempotent, so a replay that reached the transaction may enqueue it again.
    const step = PENDING_STEP[summary.state];
    if (step) await pipeline.enqueue(step, { jobId });
    return summary;
  }

  /** `only` keeps one owner's jobs; `except` drops them. The dev executor passes `only` (D18). */
  async function listJobs(
    input: ListJobsInput,
    owner: { only?: string; except?: string } = {},
  ): Promise<ListJobsOutput> {
    const at = Timestamp.fromDate(now());
    const snap = await db.collection("jobs").where("state", "in", BOARD_STATES).get();
    const jobs = snap.docs
      .map((doc) => ({ id: doc.id, job: doc.data() as JobDoc }))
      .filter(({ job }) => job.state === "open" || claimExpired(job, at))
      .filter(({ job }) => job.deadline.toMillis() > at.toMillis())
      .filter(({ job }) => !input.types || input.types.includes(job.type))
      .filter(({ job }) => input.min_reward === undefined || job.budget >= input.min_reward)
      .filter(({ job }) => !owner.only || job.posterOwnerId === owner.only)
      .filter(({ job }) => !owner.except || job.posterOwnerId !== owner.except)
      .sort((a, b) => a.job.createdAt.toMillis() - b.job.createdAt.toMillis())
      .slice(0, BOARD_LIMIT)
      // An expired claim reads as open; the next claim or status call writes it back.
      .map(({ id, job }) => toSummary(id, { ...job, state: "open" }));
    return { jobs };
  }

  /** Long-poll for runners: the oldest claimable job, or null after `waitMs` or on disconnect. */
  async function nextJob(
    agent: Agent,
    { types, sameOwner = false }: { types?: JobType[]; sameOwner?: boolean },
    waitMs: number,
    signal?: AbortSignal,
  ) {
    requireRole(agent, "runner");
    const until = Date.now() + waitMs;
    const owner = sameOwner ? { only: agent.ownerId } : { except: agent.ownerId };
    for (;;) {
      const [job] = (await listJobs({ types }, owner)).jobs;
      if (job || Date.now() >= until || signal?.aborted) return job ?? null;
      await sleep(Math.min(POLL_INTERVAL_MS, until - Date.now()), undefined, { signal }).catch(
        () => {},
      );
    }
  }

  async function claimJob(
    agent: Agent,
    jobId: string,
    { sameOwner = false }: { sameOwner?: boolean } = {},
  ): Promise<ClaimJobOutput> {
    requireRole(agent, "runner");
    const settled = await updateJob(db, jobId, now(), async (u) => {
      if (sameOwner && u.job.posterOwnerId !== agent.ownerId) {
        throw new HqError(
          "forbidden",
          "Job was posted by a different owner",
          "The dev command executor only claims jobs posted by your own owner",
        );
      }
      // Read before expireClaimIfDue, which writes; Firestore needs every read first.
      const ownerAccount = accounts.owner(agent.ownerId);
      let balance = await balanceInTx(u.tx, db, ownerAccount);
      const refund = expireClaimIfDue(u, config.TIMEOUT_SLASH_PERCENT);
      if (refund?.ownerId === agent.ownerId) balance += refund.amount;
      expireJobIfDue(u);
      if (u.job.state === "expired") return { expired: true as const };
      // A retried claim by the same runner returns the existing claim.
      const held = u.job.claim;
      if (held?.runnerAgentId === agent.id) return { job: u.job, claim: held };
      if (!sameOwner && u.job.posterOwnerId === agent.ownerId) {
        throw new HqError(
          "forbidden",
          "A runner cannot claim a job posted by its own owner",
          "Claim a job from another owner",
        );
      }
      if (u.job.state !== "open") {
        throw new HqError(
          "conflict",
          `Job is ${u.job.state}`,
          "Call list_jobs and claim an open job",
        );
      }
      const deadlineMs = Math.min(
        u.at.toMillis() + config.CLAIM_TTL_SECONDS * 1000,
        u.job.deadline.toMillis(),
      );
      const stake = stakeFor(u.job.budget, config.STAKE_PERCENT);
      requireCredits(balance, stake, "The stake for this job");
      const claim = {
        runnerAgentId: agent.id,
        runnerOwnerId: agent.ownerId,
        stake,
        claimedAt: u.at,
        deadline: Timestamp.fromMillis(deadlineMs),
        attemptsLeft: config.CLAIM_ATTEMPTS,
      };
      u.job.claim = claim;
      u.move("claimed", `Field agent ${codename(agent.id)} took the mission`);
      transfer(
        u.tx,
        db,
        {
          from: ownerAccount,
          to: accounts.stake(jobId, agent.id),
          amount: stake,
          jobId,
          reason: "Stake held for the claim",
        },
        u.at,
      );
      return { job: u.job, claim };
    });
    if ("expired" in settled) {
      throw new HqError("invalid_state", "Job deadline has passed", "Claim a different job");
    }
    const { job, claim } = settled;
    return {
      job: {
        ...toSummary(jobId, job),
        spec: await getText(blobs, job.specRef),
        public_tests: job.publicTests,
      },
      claim_deadline: claim.deadline.toDate().toISOString(),
      attempts_left: claim.attemptsLeft,
    };
  }

  async function submitResult(agent: Agent, input: Submission): Promise<SubmitResultOutput> {
    requireRole(agent, "runner");
    const jobId = input.job_id;
    const submissionId = deterministicId("sub", agent.id, jobId, input.idempotency_key);
    const subRef = jobRef(db, jobId).collection("submissions").doc(submissionId);
    const requestHash = hashJson(input);

    // Check for a replay before writing the blob, so a conflicting retry can't overwrite it.
    const existing = await subRef.get();
    if (existing.exists) {
      const job = await jobRef(db, jobId).get();
      const state = job.get("state") as JobState;
      return enqueueCheck(
        replaySubmission(jobId, submissionId, existing.data()!, requestHash, state),
      );
    }
    await limits.requireRunning();

    const resultRef = await putJson(
      blobs,
      `jobs/${jobId}/submissions/${submissionId}.json`,
      input.result,
    );
    const out = await updateJob(db, jobId, now(), async (u) => {
      const snap = await u.tx.get(subRef);
      if (snap.exists) {
        return replaySubmission(jobId, submissionId, snap.data()!, requestHash, u.job.state);
      }
      expireClaimIfDue(u, config.TIMEOUT_SLASH_PERCENT);
      expireJobIfDue(u);
      if (u.job.state === "expired") return { expired: true as const };
      const claim = u.job.claim;
      const fixHint = "Claim the job with claim_job before submitting; get_status shows its state";
      if (claim?.runnerAgentId !== agent.id) {
        throw new HqError("invalid_state", "You do not hold an active claim on this job", fixHint);
      }
      if (!CLAIM_HELD_STATES.includes(u.job.state)) {
        throw new HqError("invalid_state", `Job is ${u.job.state}`, fixHint);
      }
      if (claim.attemptsLeft <= 0) {
        throw new HqError("invalid_state", "No submission attempts left", "Claim another job");
      }
      // Claims can end and reopen, so attempts alone don't bound the checks a job costs (D32).
      const checksUsed = u.job.checksUsed ?? 0;
      if (checksUsed >= config.LIMIT_CHECKS_PER_JOB) {
        throw new HqError(
          "rate_limited",
          `This job has used all ${config.LIMIT_CHECKS_PER_JOB} of its checks`,
          "Claim another job",
        );
      }
      u.job.checksUsed = checksUsed + 1;
      claim.attemptsLeft -= 1;
      u.tx.create(subRef, {
        runnerAgentId: agent.id,
        resultRef,
        outcome: null,
        testSummary: null,
        idempotencyKey: input.idempotency_key,
        requestHash,
        attemptsLeft: claim.attemptsLeft,
        createdAt: u.at,
      });
      u.move("submitted", "Debrief handed in");
      return {
        job_id: jobId,
        submission_id: submissionId,
        state: u.job.state,
        attempts_left: claim.attemptsLeft,
      };
    });
    if ("expired" in out) {
      throw new HqError("invalid_state", "Job deadline has passed", "Claim a different job");
    }
    return enqueueCheck(out);
  }

  /** Steps are idempotent, so re-enqueueing on a replay recovers a check that never finished. */
  async function enqueueCheck(out: SubmitResultOutput): Promise<SubmitResultOutput> {
    if (out.state === "submitted" || out.state === "checking") {
      await pipeline.enqueue("check", { jobId: out.job_id, submissionId: out.submission_id });
    }
    return out;
  }

  async function getStatus(agent: Agent, jobId: string): Promise<JobStatus> {
    const ref = jobRef(db, jobId);
    const eventsQuery = ref.collection("events").orderBy("seq");
    const [snap, firstEvents] = await Promise.all([ref.get(), eventsQuery.get()]);
    let events = firstEvents;
    if (!snap.exists) throw jobNotFound(jobId);
    let job = snap.data() as JobDoc;
    // An expired claim or an open job past its deadline needs a write. Plain reads stay off it.
    const at = Timestamp.fromDate(now());
    if (
      claimExpired(job, at) ||
      (job.state === "open" && job.deadline.toMillis() <= at.toMillis())
    ) {
      job = await updateJob(db, jobId, now(), (u) => {
        expireClaimIfDue(u, config.TIMEOUT_SLASH_PERCENT);
        expireJobIfDue(u);
        return u.job;
      });
      events = await eventsQuery.get();
    }
    const role = roleOf(job, agent);
    const status: JobStatus = {
      ...toSummary(jobId, job),
      role,
      events: events.docs.map((doc): JobEvent => ({
        seq: doc.get("seq"),
        from: doc.get("from"),
        to: doc.get("to"),
        detail: doc.get("detail"),
        at: (doc.get("createdAt") as Timestamp).toDate().toISOString(),
      })),
    };
    if (job.claim && role !== "observer") {
      status.claim = {
        deadline: job.claim.deadline.toDate().toISOString(),
        attempts_left: job.claim.attemptsLeft,
      };
    }
    if (job.lastCheck && role !== "observer") {
      const { submissionId, outcome, summary } = job.lastCheck;
      status.last_check = {
        submission_id: submissionId,
        outcome,
        ...(summary ? { summary } : {}),
      };
      // The reason is about the runner's own result, so only the runner sees it.
      if (role === "runner" && (outcome === "rejected" || outcome === "blocked")) {
        const sub = await ref.collection("submissions").doc(submissionId).get();
        const reason = sub.get("rejectedReason") as string | null;
        if (reason) status.last_check.reason = reason;
      }
    }
    if (role === "poster") {
      if (job.rejection) status.rejection = job.rejection;
      if (job.redactions) status.redactions = job.redactions;
      if (job.testStrength?.fixHint) status.test_fix_hint = job.testStrength.fixHint;
    }
    // Posters never see a result before it passes and is released. Private values come back
    // only here, on the poster's side.
    if (role === "poster" && job.state === "released" && job.passedSubmissionId) {
      const [sub, map] = await Promise.all([
        jobRef(db, jobId).collection("submissions").doc(job.passedSubmissionId).get(),
        loadPlaceholders(db, vault, jobId),
      ]);
      const result = await getJson<CodeFile[]>(blobs, sub.get("resultRef"));
      status.result = result.map((f) => ({ ...f, content: restore(f.content, map) }));
    }
    return status;
  }

  async function getBalance(agent: Agent): Promise<BalanceOutput> {
    return { balance: await balanceOf(db, accounts.owner(agent.ownerId)) };
  }

  return { postJob, listJobs, nextJob, claimJob, submitResult, getStatus, getBalance };
}

function requireRole(agent: Agent, role: AgentRole): void {
  if (agent.role !== role) {
    throw new HqError(
      "forbidden",
      `This call needs a ${role} agent; your key belongs to a ${agent.role}`,
      `Use a ${role} agent's API key`,
    );
  }
}

function roleOf(job: JobDoc, agent: Agent): JobStatus["role"] {
  if (job.posterAgentId === agent.id) return "poster";
  if (job.claim?.runnerAgentId === agent.id) return "runner";
  return "observer";
}

function replaySubmission(
  jobId: string,
  submissionId: string,
  sub: DocumentData,
  requestHash: string,
  state: JobState,
): SubmitResultOutput {
  if (sub.requestHash !== requestHash) throw idempotencyConflict();
  return { job_id: jobId, submission_id: submissionId, state, attempts_left: sub.attemptsLeft };
}

function replayJob(jobId: string, job: JobDoc, requestHash: string): JobSummary {
  if (job.requestHash !== requestHash) throw idempotencyConflict();
  return toSummary(jobId, job);
}

function idempotencyConflict(): HqError {
  return new HqError(
    "conflict",
    "idempotency_key was already used with a different request",
    "Use a new idempotency_key for a new request, or resend the original request unchanged",
  );
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Hex(parts.join("\0")).slice(0, 24)}`;
}

function hashJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}
