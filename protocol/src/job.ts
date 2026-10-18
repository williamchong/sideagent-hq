import { z } from "zod";

export const LIMITS = {
  maxFiles: 50,
  maxFileBytes: 256 * 1024,
  maxPathLength: 200,
  maxSpecLength: 20_000,
} as const;

export const JobType = z.enum([
  "code.implement",
  "code.test",
  "data.extract",
  "data.label",
  "research.public",
  "translate",
  "eval.run",
]);
export type JobType = z.infer<typeof JobType>;

// Only python is implemented (D15). Runtime-specific logic lives in hq/src/runtimes/.
export const Runtime = z.enum(["python"]);
export type Runtime = z.infer<typeof Runtime>;

export const JobState = z.enum([
  "draft",
  "screening",
  "test_review",
  "open",
  "claimed",
  "running",
  "submitted",
  "checking",
  "passed",
  "failed",
  "released",
  "expired",
  "rejected",
  "cancelled",
  "disputed",
]);
export type JobState = z.infer<typeof JobState>;

export type A2ATaskState =
  "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected";

// Mapping from docs/design.md "Mission lifecycle"; check against the current A2A spec before the A2A adapter.
export const A2A_STATE: Record<JobState, A2ATaskState> = {
  draft: "submitted",
  screening: "submitted",
  test_review: "submitted",
  open: "submitted",
  claimed: "working",
  running: "working",
  submitted: "working",
  checking: "working",
  passed: "working",
  failed: "failed",
  released: "completed",
  expired: "failed",
  rejected: "rejected",
  cancelled: "canceled",
  disputed: "input-required",
};

// States with no outgoing edge. `cancelled` and `disputed` are never written.
// `expired` is written when an open job passes its deadline, and then cannot move.
export const TERMINAL_STATES: readonly JobState[] = [
  "released",
  "expired",
  "rejected",
  "cancelled",
  "disputed",
];

const RelativePath = z
  .string()
  .min(1)
  .max(LIMITS.maxPathLength)
  .refine((p) => !/^([a-zA-Z]:|[\\/])/.test(p) && !p.includes("\0"), {
    message: "Path must be relative",
  })
  .refine((p) => !p.split(/[\\/]/).includes(".."), {
    message: "Path must not contain '..'",
  });

export const CodeFile = z.object({
  path: RelativePath,
  content: z.string().max(LIMITS.maxFileBytes),
});
export type CodeFile = z.infer<typeof CodeFile>;

const Files = z.array(CodeFile).max(LIMITS.maxFiles);

export const JobSpec = z
  .object({
    type: JobType,
    runtime: Runtime.optional().describe("Required for code.* job types"),
    title: z.string().min(1).max(200),
    spec: z.string().min(1).max(LIMITS.maxSpecLength).describe("Task description and constraints"),
    public_tests: Files.min(1).describe(
      "Example tests the runner can see. Python: pytest files with `def test_*` functions",
    ),
    hidden_tests: Files.optional().describe(
      "Tests the runner never sees; decide pass/fail. Same format as public_tests",
    ),
    reference_solution: Files.optional().describe("Must pass all tests"),
    budget: z.number().int().positive().describe("Credits; 1 credit = 1 minute of agent work"),
    deadline: z.iso.datetime({ offset: true }),
    idempotency_key: z.string().min(1).max(128),
  })
  .superRefine((job, ctx) => {
    if (job.type.startsWith("code.") && !job.runtime) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "runtime is required for code jobs",
      });
    }
  });
export type JobSpec = z.infer<typeof JobSpec>;
