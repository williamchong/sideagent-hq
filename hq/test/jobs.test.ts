import { ApiError, ClaimJobOutput, JobStatus, JobSummary } from "@sideagent/protocol";
import { describe, expect, it, vi } from "vitest";
import { createHarness, SOLUTION, WRONG } from "./harness.ts";

const h = createHarness();

async function balance(key: string): Promise<number> {
  return (await h.call(key, "GET", "/v1/balance")).body.balance;
}

async function submit(key: string, jobId: string, content: string, idempotencyKey: string) {
  const res = await h.call(key, "POST", `/v1/jobs/${jobId}/submissions`, {
    result: [{ path: "solution.py", content }],
    idempotency_key: idempotencyKey,
  });
  expect(res.status).toBe(200);
  return res;
}

/** Waits until the check has run, then returns the job's status as seen by `key`. */
async function settled(key: string, jobId: string): Promise<JobStatus> {
  let status: JobStatus | undefined;
  await vi.waitFor(async () => {
    status = JobStatus.parse((await h.call(key, "GET", `/v1/jobs/${jobId}`)).body);
    expect(["submitted", "checking", "passed"]).not.toContain(status.state);
  });
  return status!;
}

async function postedJob() {
  const keys = await h.agents();
  const field = await h.agents();
  const { res, jobId, status } = await h.post(keys.poster);
  expect(res.status).toBe(200);
  expect(status?.state).toBe("open");
  return { keys, field, jobId: jobId! };
}

describe("auth", () => {
  it("rejects a missing or unknown key", async () => {
    for (const key of [null, "sk_unknown"]) {
      const res = await h.call(key, "GET", "/v1/jobs");
      expect(res.status).toBe(401);
      expect(ApiError.parse(res.body).code).toBe("unauthorized");
    }
  });

  it("refuses calls made with the wrong role", async () => {
    const keys = await h.agents();
    const res = await h.call(keys.runner, "POST", "/v1/jobs", h.jobSpec());
    expect(res.status).toBe(403);
    expect(ApiError.parse(res.body).code).toBe("forbidden");
  });
});

describe("post_job", () => {
  it("returns a draft at once, then screens and reviews the job before it opens", async () => {
    const keys = await h.agents();
    const posted = await h.call(keys.poster, "POST", "/v1/jobs", h.jobSpec());
    const summary = JobSummary.parse(posted.body);
    expect(summary.state).toBe("draft");
    await vi.waitFor(async () => {
      const status = JobStatus.parse(
        (await h.call(keys.poster, "GET", `/v1/jobs/${summary.job_id}`)).body,
      );
      expect(status.role).toBe("poster");
      expect(status.events.map((e) => [e.from, e.to])).toEqual([
        [null, "draft"],
        ["draft", "screening"],
        ["screening", "test_review"],
        ["test_review", "open"],
      ]);
    });
  });

  it("returns the same job for a repeated idempotency key", async () => {
    const keys = await h.agents();
    const spec = h.jobSpec();
    const first = await h.post(keys.poster, spec);
    const second = await h.call(keys.poster, "POST", "/v1/jobs", spec);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.res.body, state: "open", test_strength: 90 });
    const status = JobStatus.parse(
      (await h.call(keys.poster, "GET", `/v1/jobs/${first.jobId}`)).body,
    );
    expect(status.events).toHaveLength(4);
  });

  it("refuses a reused idempotency key with a different request", async () => {
    const keys = await h.agents();
    const spec = h.jobSpec();
    await h.call(keys.poster, "POST", "/v1/jobs", spec);
    const res = await h.call(keys.poster, "POST", "/v1/jobs", { ...spec, budget: 99 });
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe("conflict");
  });

  it("explains validation failures", async () => {
    const keys = await h.agents();
    const res = await h.call(keys.poster, "POST", "/v1/jobs", {
      ...h.jobSpec(),
      runtime: undefined,
    });
    expect(res.status).toBe(400);
    const err = ApiError.parse(res.body);
    expect(err.code).toBe("invalid_request");
    expect(err.fix_hint).toContain("runtime");
  });
});

describe("claim and submit", () => {
  it("runs a job from open to released and gives the result only to the poster", async () => {
    const { keys, field, jobId } = await postedJob();

    const listed = await h.call(field.runner, "GET", "/v1/jobs?types=code.implement");
    expect(listed.body.jobs.map((j: JobSummary) => j.job_id)).toContain(jobId);

    const claim = await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    expect(claim.status).toBe(200);
    const claimed = ClaimJobOutput.parse(claim.body);
    expect(claimed.job.spec).toContain("add(a, b)");
    expect(claimed.attempts_left).toBe(3);

    const before = JobStatus.parse((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
    expect(before.result).toBeUndefined();

    const submitted = await submit(field.runner, jobId, SOLUTION, "s1");
    expect(submitted.body).toMatchObject({ state: "submitted", attempts_left: 2 });

    const poster = await settled(keys.poster, jobId);
    expect(poster.state).toBe("released");
    expect(poster.result?.[0]?.content).toContain("return a + b");
    expect(poster.last_check).toMatchObject({
      outcome: "passed",
      summary: { passed: 3, total: 3 },
    });
    expect(poster.events.map((e) => e.to)).toEqual([
      "draft",
      "screening",
      "test_review",
      "open",
      "claimed",
      "submitted",
      "checking",
      "passed",
      "released",
    ]);
    // The mission log names the field agent by codename, never its full ID.
    expect(poster.events.find((e) => e.to === "claimed")?.detail).toMatch(
      /^Field agent [A-Z0-9]{4} took the mission$/,
    );

    const runner = JobStatus.parse((await h.call(field.runner, "GET", `/v1/jobs/${jobId}`)).body);
    expect(runner.role).toBe("runner");
    expect(runner.result).toBeUndefined();
    const observer = JobStatus.parse(
      (await h.call(keys.otherRunner, "GET", `/v1/jobs/${jobId}`)).body,
    );
    expect(observer.role).toBe("observer");
    expect(observer.claim).toBeUndefined();
  });

  it("withholds a wrong answer and gives the job back to the runner with counts only", async () => {
    const { keys, field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    await submit(field.runner, jobId, WRONG, "wrong");

    const poster = await settled(keys.poster, jobId);
    expect(poster.state).toBe("claimed");
    expect(poster.result).toBeUndefined();
    expect(poster.events.map((e) => e.to).slice(-4)).toEqual([
      "submitted",
      "checking",
      "failed",
      "claimed",
    ]);
    expect(poster.last_check).toEqual({
      submission_id: expect.any(String),
      outcome: "failed",
      // The trap check counts under hidden.
      summary: {
        passed: 0,
        total: 3,
        categories: { hidden: { passed: 0, total: 2 }, public: { passed: 0, total: 1 } },
      },
    });

    const runner = JobStatus.parse((await h.call(field.runner, "GET", `/v1/jobs/${jobId}`)).body);
    expect(runner.claim?.attempts_left).toBe(2);
    await submit(field.runner, jobId, SOLUTION, "right");
    expect((await settled(keys.poster, jobId)).state).toBe("released");
  });

  it("reopens the job and returns the stake when the attempts run out", async () => {
    const { keys, field, jobId } = await postedJob();
    const before = await balance(field.runner);
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    expect(await balance(field.runner)).toBe(before - 2);
    for (let i = 0; i < h.config.CLAIM_ATTEMPTS; i++) {
      await submit(field.runner, jobId, WRONG, `wrong-${i}`);
      await settled(keys.poster, jobId);
    }
    const status = JobStatus.parse((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
    expect(status.state).toBe("open");
    expect(status.claim).toBeUndefined();
    expect(await balance(field.runner)).toBe(before);
  });

  it("shows why a result was rejected to the runner only", async () => {
    const { keys, field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    h.sandbox.next = async () => ({
      kind: "rejected",
      error: {
        code: "invalid_request",
        reason: "conftest.py can't be part of a result",
        fix_hint: "",
      },
    });
    await submit(field.runner, jobId, WRONG, "rejected");

    const poster = await settled(keys.poster, jobId);
    expect(poster.last_check).toEqual({ submission_id: expect.any(String), outcome: "rejected" });
    expect(JSON.stringify(poster)).not.toContain("conftest");
    const runner = JobStatus.parse((await h.call(field.runner, "GET", `/v1/jobs/${jobId}`)).body);
    expect(runner.last_check?.reason).toContain("conftest.py");
  });

  it("keeps the job in checking when the sandbox fails, and a retried submit resumes it", async () => {
    const { keys, field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    h.sandbox.next = async () => {
      throw new Error("docker is down");
    };
    await submit(field.runner, jobId, SOLUTION, "s1");
    await vi.waitFor(async () => {
      const status = await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`);
      expect(status.body.state).toBe("checking");
    });
    await new Promise((r) => setTimeout(r, 100));
    expect((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body.state).toBe("checking");

    const replay = await submit(field.runner, jobId, SOLUTION, "s1");
    expect(replay.body.attempts_left).toBe(2);
    expect((await settled(keys.poster, jobId)).state).toBe("released");
  });

  it("does not re-check an older submission when its submit is retried", async () => {
    const { keys, field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    await submit(field.runner, jobId, WRONG, "first");
    const first = await settled(keys.poster, jobId);
    h.sandbox.next = async () => {
      throw new Error("docker is down");
    };
    await submit(field.runner, jobId, SOLUTION, "second");
    await vi.waitFor(async () => {
      expect((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body.state).toBe("checking");
    });

    await submit(field.runner, jobId, WRONG, "first");
    await new Promise((r) => setTimeout(r, 200));
    const during = JobStatus.parse((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
    expect(during.state).toBe("checking");
    expect(during.last_check).toEqual(first.last_check);

    await submit(field.runner, jobId, SOLUTION, "second");
    const done = await settled(keys.poster, jobId);
    expect(done.state).toBe("released");
    expect(done.last_check?.submission_id).not.toBe(first.last_check?.submission_id);
  });

  it("never shows hidden tests or the reference solution to runners", async () => {
    const { field, jobId } = await postedJob();
    const responses = [
      await h.call(field.runner, "GET", "/v1/jobs"),
      await h.call(field.runner, "GET", "/v1/runner/next?wait=0"),
      await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`),
      await h.call(field.runner, "GET", `/v1/jobs/${jobId}`),
      await submit(field.runner, jobId, WRONG, "wrong"),
    ];
    await settled(field.runner, jobId);
    responses.push(await h.call(field.runner, "GET", `/v1/jobs/${jobId}`));
    for (const res of responses) {
      expect(res.text).not.toMatch(
        /HIDDEN_MARKER|REFERENCE_MARKER|hidden_tests|reference_solution/,
      );
    }
  });

  // The emulator makes the losing transaction wait for the lock and retry with backoff, which
  // takes 3–4 s and has gone past the default 5 s timeout in CI.
  it("lets exactly one of two concurrent claims win", { timeout: 20_000 }, async () => {
    const { field, jobId } = await postedJob();
    const results = await Promise.all([
      h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`),
      h.call(field.otherRunner, "POST", `/v1/jobs/${jobId}/claim`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("returns the existing claim when the same runner claims again", async () => {
    const { field, jobId } = await postedJob();
    const first = await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    const second = await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    expect(second.status).toBe(200);
    expect(second.body.claim_deadline).toBe(first.body.claim_deadline);
  });

  it("counts a repeated submission once", async () => {
    const { field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    const body = { result: [{ path: "solution.py", content: SOLUTION }], idempotency_key: "k" };
    const first = await h.call(field.runner, "POST", `/v1/jobs/${jobId}/submissions`, body);
    const second = await h.call(field.runner, "POST", `/v1/jobs/${jobId}/submissions`, body);
    expect(second.body.submission_id).toBe(first.body.submission_id);
    expect(second.body.attempts_left).toBe(2);
  });

  it("refuses a submission from a runner without the claim", async () => {
    const { field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    const res = await h.call(field.otherRunner, "POST", `/v1/jobs/${jobId}/submissions`, {
      result: [{ path: "solution.py", content: "x = 1\n" }],
      idempotency_key: "k",
    });
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe("invalid_state");
  });
});

describe("escrow and stakes", () => {
  it("holds budget and fee on post and pays the budget to the runner's owner on release", async () => {
    const posterKeys = await h.agents();
    const runnerKeys = await h.agents();
    const { jobId } = await h.post(posterKeys.poster, h.jobSpec({ budget: 10 }));
    expect(await balance(posterKeys.poster)).toBe(89);

    await h.call(runnerKeys.runner, "POST", `/v1/jobs/${jobId}/claim`);
    expect(await balance(runnerKeys.runner)).toBe(98);
    await submit(runnerKeys.runner, jobId!, SOLUTION, "s1");
    expect((await settled(posterKeys.poster, jobId!)).state).toBe("released");
    expect(await balance(posterKeys.poster)).toBe(89);
    expect(await balance(runnerKeys.runner)).toBe(110);
  });

  it("refuses a post or claim the owner can't cover", async () => {
    const poor = await h.agents(5);
    const post = await h.call(poor.poster, "POST", "/v1/jobs", h.jobSpec({ budget: 10 }));
    expect(post.status).toBe(402);
    expect(ApiError.parse(post.body).code).toBe("insufficient_credits");

    const { jobId } = await postedJob();
    const broke = await h.agents(0);
    const claim = await h.call(broke.runner, "POST", `/v1/jobs/${jobId}/claim`);
    expect(claim.status).toBe(402);
    expect((await h.call(broke.runner, "GET", `/v1/jobs/${jobId}`)).body.state).toBe("open");
  });
});

describe("claim timeout", () => {
  it("returns a timed-out job to open for another runner", async () => {
    const { field, jobId } = await postedJob();
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);

    const started = h.clock.now;
    h.clock.now = new Date(started.getTime() + (h.config.CLAIM_TTL_SECONDS + 1) * 1000);
    try {
      const listed = await h.call(field.otherRunner, "GET", "/v1/jobs");
      const entry = listed.body.jobs.find((j: JobSummary) => j.job_id === jobId);
      expect(entry?.state).toBe("open");

      const status = JobStatus.parse((await h.call(field.runner, "GET", `/v1/jobs/${jobId}`)).body);
      expect(status.state).toBe("open");
      expect(status.events.at(-1)).toMatchObject({ from: "claimed", to: "open" });

      const late = await h.call(field.runner, "POST", `/v1/jobs/${jobId}/submissions`, {
        result: [{ path: "solution.py", content: "x = 1\n" }],
        idempotency_key: "late",
      });
      expect(late.status).toBe(409);

      const reclaim = await h.call(field.otherRunner, "POST", `/v1/jobs/${jobId}/claim`);
      expect(reclaim.status).toBe(200);
      // Half of the first stake was slashed, and the second claim holds another 2.
      expect(await balance(field.runner)).toBe(h.config.STARTING_CREDITS - 3);
    } finally {
      h.clock.now = started;
    }
  });
});

describe("job deadline", () => {
  it("expires an open job on the next status read and returns the budget", async () => {
    const keys = await h.agents();
    const deadline = new Date(h.clock.now.getTime() + 60_000).toISOString();
    const { jobId } = await h.post(keys.poster, h.jobSpec({ deadline, budget: 10 }));
    expect(await balance(keys.poster)).toBe(h.config.STARTING_CREDITS - 10 - h.config.SCREENING_FEE);

    const started = h.clock.now;
    h.clock.now = new Date(started.getTime() + 61_000);
    try {
      const status = JobStatus.parse((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
      expect(status.state).toBe("expired");
      expect(status.events.at(-1)).toMatchObject({ from: "open", to: "expired" });
      expect(await balance(keys.poster)).toBe(h.config.STARTING_CREDITS - h.config.SCREENING_FEE);

      const again = JobStatus.parse((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
      expect(again.state).toBe("expired");
      expect(await balance(keys.poster)).toBe(h.config.STARTING_CREDITS - h.config.SCREENING_FEE);

      const claim = await h.call(keys.runner, "POST", `/v1/jobs/${jobId}/claim`);
      expect(claim.status).toBe(409);
      const listed = await h.call(keys.runner, "GET", "/v1/jobs");
      expect(listed.body.jobs.map((j: JobSummary) => j.job_id)).not.toContain(jobId);
    } finally {
      h.clock.now = started;
    }
  });
});

describe("runner long-poll", () => {
  it("returns 204 when no job matches", async () => {
    const keys = await h.agents();
    const res = await h.call(keys.runner, "GET", "/v1/runner/next?types=eval.run&wait=0");
    expect(res.status).toBe(204);
  });

  it("refuses a runner claiming a job posted by its own owner", async () => {
    const { keys, jobId } = await postedJob();
    const claim = await h.call(keys.runner, "POST", `/v1/jobs/${jobId}/claim`);
    expect(claim.status).toBe(403);
    expect(ApiError.parse(claim.body).code).toBe("forbidden");
    expect((await h.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body.state).toBe("open");
    expect(await balance(keys.runner)).toBe(h.config.STARTING_CREDITS - 10 - h.config.SCREENING_FEE);

    const next = await h.call(keys.runner, "GET", "/v1/runner/next?wait=0");
    if (next.status === 200) expect(next.body.job_id).not.toBe(jobId);
    else expect(next.status).toBe(204);
  });

  it("with same_owner, skips jobs from other owners", async () => {
    const { jobId } = await postedJob();
    const keys = await h.agents();
    const res = await h.call(keys.runner, "GET", "/v1/runner/next?same_owner=true&wait=0");
    expect(res.status).toBe(204);

    const claim = await h.call(keys.runner, "POST", `/v1/jobs/${jobId}/claim?same_owner=true`);
    expect(claim.status).toBe(403);
    expect(ApiError.parse(claim.body).code).toBe("forbidden");
  });

  it("with same_owner, returns and claims the owner's own job", async () => {
    const { keys, jobId } = await postedJob();
    const next = await h.call(keys.runner, "GET", "/v1/runner/next?same_owner=true&wait=0");
    expect(JobSummary.parse(next.body).job_id).toBe(jobId);

    const claim = await h.call(keys.runner, "POST", `/v1/jobs/${jobId}/claim?same_owner=true`);
    expect(claim.status).toBe(200);
    ClaimJobOutput.parse(claim.body);
  });
});
