import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JobStatus,
  type JobSpec,
  type ScreeningVerdict,
  type TrapTestDrafts,
} from "@sideagent/protocol";
import { expect, vi } from "vitest";
import type { GenerateJson, JsonAnswer, PlatformModel } from "../src/agents/model.ts";
import type { HouseRunnerDispatcher } from "../src/adapters/dispatch/types.ts";
import { createAdapters, type GcpClients } from "../src/adapters/index.ts";
import { createApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { CheckOutcome, MutantScore, Sandbox } from "../src/sandbox/types.ts";
import { createAgent } from "../src/store/agents.ts";
import { createOwner } from "../src/store/owners.ts";

export const SOLUTION = "def add(a, b):\n    return a + b\n";
export const WRONG = "def add(a, b):\n    return None\n";
/** A double agent's answer: fitted to the public example, wrong anywhere else. */
export const CHEAT = "def add(a, b):\n    return {(1, 2): 3}.get((a, b))  # LOOKUP\n";

/**
 * Stands in for Docker in pipeline tests. A result passes a category's one test when it holds
 * SOLUTION's body; CHEAT passes only `public`; any result passes a test file marked PASSES_EMPTY.
 * Set `next` to make the following check return or throw something else. `bundles` records
 * every check, review runs included. Mutant requests are scored as `mutants` (one-shot), 9 of 10
 * caught by default.
 */
export function createFakeSandbox() {
  const fake = {
    next: null as (() => Promise<CheckOutcome>) | null,
    mutants: null as MutantScore | null,
    bundles: [] as Parameters<Sandbox["runChecks"]>[0][],
    runChecks: async (bundle: Parameters<Sandbox["runChecks"]>[0]): Promise<CheckOutcome> => {
      fake.bundles.push(bundle);
      const override = fake.next;
      fake.next = null;
      if (override) return override();
      const ok = bundle.result.some((f) => f.content.includes("return a + b"));
      const cheat = bundle.result.some((f) => f.content.includes("LOOKUP"));
      const categories = Object.fromEntries(
        Object.entries(bundle.tests)
          .filter(([, files]) => files.length)
          .map(([name, files]) => {
            const failing = files.some((f) => f.content.includes("FAILS_REFERENCE"));
            const always = files.every((f) => f.content.includes("PASSES_EMPTY"));
            const pass = always || (!failing && (ok || (cheat && name === "public")));
            return [name, { passed: pass ? 1 : 0, total: 1 }];
          }),
      );
      const counts = Object.values(categories);
      const testsPass = bundle.mutants?.categories.every((c) => categories[c]?.passed);
      const mutants = fake.mutants ?? { killed: 9, total: 10 };
      if (bundle.mutants) fake.mutants = null;
      return {
        kind: "scored",
        summary: {
          passed: counts.reduce((n, c) => n + c.passed, 0),
          total: counts.length,
          categories,
        },
        ...(testsPass ? { mutants } : {}),
      };
    },
  };
  return fake;
}

const ALLOW: ScreeningVerdict = {
  verdict: "allow",
  categories: [],
  confidence: 0.99,
  reason: "Ordinary task",
  fix_hint: "",
};

/**
 * Stands in for Gemini. Screeners allow and the trap writer drafts one passing trap check,
 * unless a test sets an answer for that agent in `answers` (used once) or `byAgent` (kept).
 */
type FakeAnswer = { value: unknown; confidence?: number | null };

export function createFakeModel() {
  const calls: GenerateJson<unknown>[] = [];
  const answers: Record<string, FakeAnswer | Error> = {};
  const byAgent: Record<string, FakeAnswer> = {};
  async function generateJson<T>(req: GenerateJson<T>): Promise<JsonAnswer<T>> {
    calls.push(req as GenerateJson<unknown>);
    const once = answers[req.agent];
    delete answers[req.agent];
    if (once instanceof Error) throw once;
    const answer = once ?? byAgent[req.agent] ?? { value: defaultAnswer(req.agent) };
    return { value: req.schema.parse(answer.value), confidence: answer.confidence ?? null };
  }
  const model: PlatformModel = { generateJson };
  return { ...model, calls, answers, byAgent };
}

function defaultAnswer(agent: string): unknown {
  if (agent !== "trap-writer") return ALLOW;
  const drafts: TrapTestDrafts = {
    tests: [
      {
        name: "add_more",
        content: "from solution import add\n\ndef test_more():\n    assert add(5, 7) == 12\n",
      },
    ],
  };
  return drafts;
}

// Runs against the Firestore emulator started by `pnpm test`. Every test creates its own
// owner and agents, so test files can share the emulator without clearing it.
// House runners are off unless a test passes a `dispatcher`, and GCP clients are the fakes in
// `gcp`. Post limits are lifted unless a test sets them in `config`, and each harness has its
// own counters and kill switch, the switch read without a cache.
export function createHarness({
  dispatcher = null,
  config: overrides = {},
  gcp,
}: {
  dispatcher?: HouseRunnerDispatcher | null;
  config?: Partial<Config>;
  gcp?: GcpClients;
} = {}) {
  // Without the emulators, firebase-admin would talk to a real project.
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("Run tests through `pnpm test`, which starts the Firestore and Auth emulators");
  }
  const dir = mkdtempSync(join(tmpdir(), "sideagent-blobs-"));
  const config = {
    ...loadConfig(process.env),
    BLOB_LOCAL_DIR: dir,
    VAULT_LOCAL_KEY_FILE: join(dir, "vault.key"),
    LIMIT_POSTS_PER_HOUR: 1_000_000,
    LIMIT_POSTS_PER_DAY: 1_000_000,
    HOUSE_RUNNER_DELAY_SECONDS: 0,
    ALLOW_SAME_OWNER: true,
    ...overrides,
  };
  const sandbox = createFakeSandbox();
  const model = createFakeModel();
  const testId = randomUUID();
  const configDoc = `config/test-${testId}`;
  const adapters = createAdapters(config, {
    sandbox,
    dispatcher,
    model,
    limits: { configDoc, usageCollection: `usage-test-${testId}`, cacheMs: 0 },
    gcp,
  });
  const clock = { now: new Date() };
  const app = createApp(config, adapters, { now: () => clock.now });

  async function call(apiKey: string | null, method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as any };
  }

  /** A poster and two runners under one new owner with `credits` starting credits. */
  async function agents(credits = config.STARTING_CREDITS) {
    const ownerId = await createOwner(adapters.db, `owner-${randomUUID()}`, credits);
    const [poster, runner, otherRunner] = await Promise.all([
      createAgent(adapters.db, ownerId, "poster"),
      createAgent(adapters.db, ownerId, "runner"),
      createAgent(adapters.db, ownerId, "runner"),
    ]);
    return {
      ownerId,
      poster: poster.apiKey,
      runner: runner.apiKey,
      otherRunner: otherRunner.apiKey,
    };
  }

  function jobSpec(overrides: Partial<JobSpec> = {}): JobSpec {
    return {
      type: "code.implement",
      runtime: "python",
      title: "Add two numbers",
      spec: "Write add(a, b) in solution.py that returns a + b.",
      public_tests: [
        {
          path: "test_public.py",
          content: "from solution import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        },
      ],
      hidden_tests: [
        {
          path: "test_hidden.py",
          content:
            "# HIDDEN_MARKER\nfrom solution import add\n\ndef test_add():\n    assert add(2, 2) == 4\n",
        },
      ],
      reference_solution: [{ path: "solution.py", content: `# REFERENCE_MARKER\n${SOLUTION}` }],
      budget: 10,
      deadline: new Date(clock.now.getTime() + 24 * 3600_000).toISOString(),
      idempotency_key: randomUUID(),
      ...overrides,
    };
  }

  /** Posts a job and waits until screening and test review let it open (or reject it). */
  async function post(apiKey: string, spec: JobSpec = jobSpec()) {
    const res = await call(apiKey, "POST", "/v1/jobs", spec);
    if (res.status !== 200) return { res, jobId: null, status: null };
    const jobId = res.body.job_id as string;
    let status: JobStatus | undefined;
    await vi.waitFor(async () => {
      status = JobStatus.parse((await call(apiKey, "GET", `/v1/jobs/${jobId}`)).body);
      expect(["draft", "screening", "test_review"]).not.toContain(status.state);
    });
    return { res, jobId, status: status! };
  }

  /** Sets this harness's kill switch (D32). */
  async function pause(paused: boolean) {
    await adapters.db.doc(configDoc).set({ paused });
  }

  return { config, adapters, sandbox, model, app, clock, call, agents, jobSpec, post, pause };
}
