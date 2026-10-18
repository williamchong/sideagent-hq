import { ApiError, JobStatus } from "@sideagent/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchStep } from "../src/pipeline/dispatch.ts";
import { createAgent } from "../src/store/agents.ts";
import { createHarness, WRONG } from "./harness.ts";

function submitWrong(
  h: ReturnType<typeof createHarness>,
  key: string,
  jobId: string,
  idempotencyKey: string,
) {
  return h.call(key, "POST", `/v1/jobs/${jobId}/submissions`, {
    result: [{ path: "solution.py", content: WRONG }],
    idempotency_key: idempotencyKey,
  });
}

function expectRateLimited(res: { status: number; body: unknown }, reason: string) {
  expect(res.status).toBe(429);
  const err = ApiError.parse(res.body);
  expect(err.code).toBe("rate_limited");
  expect(err.reason).toContain(reason);
}

describe("post limits", () => {
  const h = createHarness({ config: { LIMIT_POSTS_PER_HOUR: 2, LIMIT_POSTS_PER_DAY: 3 } });

  it("caps an owner's posts per hour, across agents, without holding escrow", async () => {
    // Each test on its own day, so they don't share the day counter.
    h.clock.now = new Date("2100-01-01T12:30:00Z");
    const keys = await h.agents();
    const first = h.jobSpec();
    expect((await h.call(keys.poster, "POST", "/v1/jobs", first)).status).toBe(200);
    expect((await h.call(keys.poster, "POST", "/v1/jobs", h.jobSpec())).status).toBe(200);
    const balance = (await h.call(keys.poster, "GET", "/v1/balance")).body.balance;

    // A second poster agent shares its owner's limit.
    const second = await createAgent(h.adapters.db, keys.ownerId, "poster");
    const refused = await h.call(second.apiKey, "POST", "/v1/jobs", h.jobSpec());
    expectRateLimited(refused, "this hour");
    expect(refused.body.fix_hint).toContain("T13:00:00.000Z");
    expect((await h.call(keys.poster, "GET", "/v1/balance")).body.balance).toBe(balance);
    // A replay of an accepted post isn't a new post.
    expect((await h.call(keys.poster, "POST", "/v1/jobs", first)).status).toBe(200);

    h.clock.now = new Date(h.clock.now.getTime() + 3600_000);
    expect((await h.call(keys.poster, "POST", "/v1/jobs", h.jobSpec())).status).toBe(200);
  });

  it("caps posts per day over all owners", async () => {
    h.clock.now = new Date("2100-01-02T12:30:00Z");
    const [a, b] = await Promise.all([h.agents(), h.agents()]);
    for (const key of [a.poster, a.poster, b.poster]) {
      expect((await h.call(key, "POST", "/v1/jobs", h.jobSpec())).status).toBe(200);
    }
    expectRateLimited(await h.call(b.poster, "POST", "/v1/jobs", h.jobSpec()), "today");
  });
});

describe("check limit", () => {
  const h = createHarness({ config: { LIMIT_CHECKS_PER_JOB: 4 } });

  async function settled(key: string, jobId: string) {
    await vi.waitFor(async () => {
      const status = JobStatus.parse((await h.call(key, "GET", `/v1/jobs/${jobId}`)).body);
      expect(["submitted", "checking"]).not.toContain(status.state);
    });
  }

  it("caps submissions per job over all its claims", async () => {
    const keys = await h.agents();
    const field = await h.agents();
    const { jobId } = await h.post(keys.poster);
    await h.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`);
    for (let i = 0; i < h.config.CLAIM_ATTEMPTS; i++) {
      expect((await submitWrong(h, field.runner, jobId!, `a-${i}`)).status).toBe(200);
      await settled(keys.poster, jobId!);
    }
    // The claim ran out of attempts and the job reopened; the next claim gets what's left.
    await h.call(field.otherRunner, "POST", `/v1/jobs/${jobId}/claim`);
    expect((await submitWrong(h, field.otherRunner, jobId!, "b-0")).status).toBe(200);
    await settled(keys.poster, jobId!);
    expectRateLimited(
      await submitWrong(h, field.otherRunner, jobId!, "b-1"),
      "all 4 of its checks",
    );
  });
});

describe("kill switch", () => {
  const h = createHarness();

  it("refuses posts and submissions and skips dispatch while paused", async () => {
    const keys = await h.agents();
    const field = await h.agents();
    const [claimed, waiting] = [await h.post(keys.poster), await h.post(keys.poster)];
    await h.call(field.runner, "POST", `/v1/jobs/${claimed.jobId}/claim`);
    const start = vi.fn(async (_jobId: string) => {});
    const dispatch = createDispatchStep(h.adapters.db, { start }, h.adapters.limits);

    await h.pause(true);
    try {
      expectRateLimited(await h.call(keys.poster, "POST", "/v1/jobs", h.jobSpec()), "paused");
      expectRateLimited(await submitWrong(h, field.runner, claimed.jobId!, "paused"), "paused");
      await dispatch({ jobId: waiting.jobId! });
      expect(start).not.toHaveBeenCalled();
    } finally {
      await h.pause(false);
    }
    expect((await h.call(keys.poster, "POST", "/v1/jobs", h.jobSpec())).status).toBe(200);
    await dispatch({ jobId: waiting.jobId! });
    expect(start).toHaveBeenCalledWith(waiting.jobId);
  });
});
