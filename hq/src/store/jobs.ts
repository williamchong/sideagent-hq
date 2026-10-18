import type { ClaimView, JobEventView, JobState, JobSummary, JobView } from "@sideagent/protocol";
import {
  Timestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { HqError } from "../errors.ts";
import { canTransition } from "../jobs/transitions.ts";
import { accounts, transfer } from "../ledger/ledger.ts";

/** `jobs/{jobId}`: what mission control reads, plus fields only HQ uses. */
export interface JobDoc extends JobView<Timestamp> {
  specRef: string;
  /** Held in escrow with the budget until screening runs (D30). */
  screeningFee: number;
  idempotencyKey: string;
  requestHash: string;
  /** Submissions over all claims, capped by LIMIT_CHECKS_PER_JOB (D32). Absent means 0. */
  checksUsed?: number;
}

/** States in which a runner holds a claim that can time out. */
export const CLAIM_HELD_STATES: readonly JobState[] = ["claimed", "running"];

export function jobRef(db: Firestore, jobId: string): DocumentReference {
  return db.collection("jobs").doc(jobId);
}

/** Appends `jobs/{jobId}/events/{seq}` and moves the in-memory job. The caller writes the job. */
export function transition(
  tx: Transaction,
  ref: DocumentReference,
  job: JobDoc,
  to: JobState,
  detail: string,
  at: Timestamp,
): void {
  if (!canTransition(job.state, to)) {
    throw new HqError(
      "invalid_state",
      `Job cannot move from ${job.state} to ${to}`,
      "Call get_status to see the job's current state",
    );
  }
  appendEvent(tx, ref, job, job.state, to, detail, at);
  job.state = to;
  job.updatedAt = at;
}

export function appendEvent(
  tx: Transaction,
  ref: DocumentReference,
  job: JobDoc,
  from: JobState | null,
  to: JobState,
  detail: string,
  at: Timestamp,
): void {
  const seq = job.eventSeq++;
  const event: JobEventView<Timestamp> = {
    type: "state",
    seq,
    from,
    to,
    detail,
    createdAt: at,
  };
  tx.create(ref.collection("events").doc(String(seq).padStart(6, "0")), event);
}

export interface JobUpdate {
  tx: Transaction;
  ref: DocumentReference;
  job: JobDoc;
  at: Timestamp;
  move(to: JobState, detail: string): void;
}

/**
 * Reads a job in a transaction, lets `fn` change it, and writes it back if it moved.
 * Field changes normally go with a transition, so an unmoved job needs no write; a change
 * without one (the dispatch mark) goes through `u.tx.update` itself.
 * `fn` must do any extra reads before calling `move`, which writes an event.
 */
export async function updateJob<T>(
  db: Firestore,
  jobId: string,
  now: Date,
  fn: (u: JobUpdate) => T | Promise<T>,
): Promise<T> {
  const ref = jobRef(db, jobId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw jobNotFound(jobId);
    const job = snap.data() as JobDoc;
    const startSeq = job.eventSeq;
    const at = Timestamp.fromDate(now);
    const out = await fn({
      tx,
      ref,
      job,
      at,
      move: (to, detail) => transition(tx, ref, job, to, detail, at),
    });
    if (job.eventSeq !== startSeq) tx.set(ref, job);
    return out;
  });
}

export function jobNotFound(jobId: string): HqError {
  return new HqError("not_found", `No job ${jobId}`, "Check the job_id; list_jobs shows open jobs");
}

/** An open job past its deadline, waiting for `expireJobIfDue` to write it back. */
export function jobExpired(job: JobDoc, at: Timestamp): boolean {
  return job.state === "open" && job.deadline.toMillis() <= at.toMillis();
}

export function claimExpired(job: JobDoc, at: Timestamp): boolean {
  return (
    CLAIM_HELD_STATES.includes(job.state) &&
    job.claim !== null &&
    job.claim.deadline.toMillis() <= at.toMillis()
  );
}

/**
 * Lazy claim timeout (D21): no timer runs; the next write path returns the job to `open`.
 * `slashPercent` of the stake goes to platform fees and the rest back to the runner's owner.
 * Returns that refund, for callers that read the owner's balance before this write.
 */
export function expireClaimIfDue(
  u: JobUpdate,
  slashPercent: number,
): { ownerId: string; amount: number } | null {
  const claim = u.job.claim;
  if (!claim || !claimExpired(u.job, u.at)) return null;
  const slashed = Math.floor((claim.stake * slashPercent) / 100);
  u.move(
    "open",
    slashed
      ? `Field agent ran out of time; lost ${slashed} credits of stake`
      : "Field agent ran out of time",
  );
  releaseStake(u, claim, slashed, "Claim timed out");
  u.job.claim = null;
  return { ownerId: claim.runnerOwnerId, amount: claim.stake - slashed };
}

/**
 * Lazy job deadline (same shape as a claim timeout): no timer runs. The next status or claim
 * call, once the job is `open`, moves it to `expired` and returns the budget. The screening
 * fee stays with the platform. A claim that is also due is settled first.
 */
export function expireJobIfDue(u: JobUpdate): void {
  if (!jobExpired(u.job, u.at)) return;
  u.move("expired", "Deadline passed; budget returned to the handler");
  refundBudget(u, "Budget refunded; job expired");
}

/** Empties the claim's stake account: `slashed` credits to fees, the rest to the runner's owner. */
export function releaseStake(
  u: JobUpdate,
  claim: ClaimView<Timestamp>,
  slashed: number,
  reason: string,
) {
  const entry = { from: accounts.stake(u.ref.id, claim.runnerAgentId), jobId: u.ref.id, reason };
  const db = u.ref.firestore;
  transfer(u.tx, db, { ...entry, to: accounts.fees, amount: slashed }, u.at);
  const to = accounts.owner(claim.runnerOwnerId);
  transfer(u.tx, db, { ...entry, to, amount: claim.stake - slashed }, u.at);
}

/** Pays the screening fee from escrow to platform fees (D30). Call once, when screening ends. */
export function takeScreeningFee(u: JobUpdate): void {
  transfer(
    u.tx,
    u.ref.firestore,
    {
      from: accounts.escrow(u.ref.id),
      to: accounts.fees,
      amount: u.job.screeningFee,
      jobId: u.ref.id,
      reason: "Screening fee",
    },
    u.at,
  );
}

/** Returns the budget in escrow to the poster's owner, for a job that never opened. */
export function refundBudget(u: JobUpdate, reason: string): void {
  transfer(
    u.tx,
    u.ref.firestore,
    {
      from: accounts.escrow(u.ref.id),
      to: accounts.owner(u.job.posterOwnerId),
      amount: u.job.budget,
      jobId: u.ref.id,
      reason,
    },
    u.at,
  );
}

export function toSummary(jobId: string, job: JobDoc): JobSummary {
  return {
    job_id: jobId,
    type: job.type,
    ...(job.runtime ? { runtime: job.runtime } : {}),
    title: job.title,
    state: job.state,
    budget: job.budget,
    deadline: job.deadline.toDate().toISOString(),
    created_at: job.createdAt.toDate().toISOString(),
    ...(job.testStrength?.score != null ? { test_strength: job.testStrength.score } : {}),
  };
}
