import { JobStatus, JobSummary } from "@sideagent/protocol";
import { describe, expect, it, vi } from "vitest";
import { houseRunnerEnv } from "../src/adapters/dispatch/local.ts";
import { createDispatchStep } from "../src/pipeline/dispatch.ts";
import { jobRef } from "../src/store/jobs.ts";
import { createHarness } from "./harness.ts";

const start = vi.fn(async (_jobId: string) => {});
const h = createHarness({ dispatcher: { start } });

async function status(key: string, jobId: string): Promise<JobStatus> {
  return JobStatus.parse((await h.call(key, "GET", `/v1/jobs/${jobId}`)).body);
}

async function dispatchedAt(harness: typeof h, jobId: string): Promise<unknown> {
  return (await jobRef(harness.adapters.db, jobId).get()).get("dispatchedAt");
}

describe("dispatch step", () => {
  it("starts one house runner when a job opens and records it on the job", async () => {
    const keys = await h.agents();
    const spec = h.jobSpec();
    const posted = await h.call(keys.poster, "POST", "/v1/jobs", spec);
    const jobId = JobSummary.parse(posted.body).job_id;
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(jobId));

    // A replayed post and a retried step both find the job already dispatched.
    await h.call(keys.poster, "POST", "/v1/jobs", spec);
    await createDispatchStep(h.adapters.db, { start }, h.adapters.limits)({ jobId });
    expect(start.mock.calls.filter(([id]) => id === jobId)).toHaveLength(1);

    // Marked on the job, but the mission log doesn't show the house runner.
    expect(await dispatchedAt(h, jobId)).toBeDefined();
    const s = await status(keys.poster, jobId);
    expect(s.state).toBe("open");
    expect(s.events.at(-1)).toMatchObject({ from: "test_review", to: "open" });
  });

  it("skips jobs that are no longer open", async () => {
    const off = createHarness();
    const keys = await off.agents();
    const field = await off.agents();
    const { jobId } = (await off.post(keys.poster)) as { jobId: string };
    await off.call(field.runner, "POST", `/v1/jobs/${jobId}/claim`, {});
    const other = vi.fn(async () => {});
    await createDispatchStep(off.adapters.db, { start: other }, off.adapters.limits)({ jobId });
    expect(other).not.toHaveBeenCalled();
  });

  it("unmarks the job when the run can't start, so a retry dispatches again", async () => {
    const off = createHarness();
    const keys = await off.agents();
    const { jobId } = (await off.post(keys.poster)) as { jobId: string };
    const failing = vi.fn(async () => Promise.reject(new Error("busy")));
    await expect(
      createDispatchStep(off.adapters.db, { start: failing }, off.adapters.limits)({ jobId }),
    ).rejects.toThrow("busy");
    expect(await dispatchedAt(off, jobId)).toBeUndefined();
    const retry = vi.fn(async () => {});
    await createDispatchStep(off.adapters.db, { start: retry }, off.adapters.limits)({ jobId });
    expect(retry).toHaveBeenCalledWith(jobId);
    expect(await dispatchedAt(off, jobId)).toBeDefined();
  });

  it("does nothing when house runners are off", async () => {
    const off = createHarness();
    const keys = await off.agents();
    const { jobId } = (await off.post(keys.poster)) as { jobId: string };
    const before = JobStatus.parse((await off.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
    await createDispatchStep(off.adapters.db, null, off.adapters.limits)({ jobId });
    const after = JobStatus.parse((await off.call(keys.poster, "GET", `/v1/jobs/${jobId}`)).body);
    expect(after.events).toEqual(before.events);
  });
});

describe("house runner environment", () => {
  it("marks the double agent's run", () => {
    const env = houseRunnerEnv(
      {
        hqUrl: "http://localhost:8080",
        apiKey: "sk_double",
        modelBackend: "vertex",
        simulateCheat: true,
      },
      {},
    );
    expect(env.SIDEAGENT_SIMULATE_CHEAT).toBe("1");
  });

  it("passes only the runner's own settings, never HQ secrets", () => {
    const env = houseRunnerEnv(
      {
        hqUrl: "http://localhost:8080",
        apiKey: "sk_house",
        modelBackend: "vertex",
        maxTokens: 200_000,
      },
      {
        PATH: "/usr/bin",
        GOOGLE_CLOUD_PROJECT: "p",
        HOUSE_RUNNER_API_KEY: "sk_house",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
        SECRET_TOKEN: "x",
      },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      GOOGLE_CLOUD_PROJECT: "p",
      SIDEAGENT_HQ_URL: "http://localhost:8080",
      SIDEAGENT_API_KEY: "sk_house",
      SIDEAGENT_MODEL_BACKEND: "vertex",
      SIDEAGENT_MAX_TOKENS: "200000",
    });
  });
});
