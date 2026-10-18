import { ModelBackendName } from "@sideagent/protocol";
import { z } from "zod";

const Percent = z.coerce.number().int().min(0).max(100);

// Local defaults for every adapter (D19). The cloud modes need the GCP variables below;
// `createAdapters` says which one is missing at startup.
const Config = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  GCP_REGION: z.string().min(1).default("us-west1"),
  // HQ's own URL: Cloud Tasks calls `${HQ_URL}/internal/steps/<step>` with it as the audience.
  HQ_URL: z
    .url()
    .transform((url) => url.replace(/\/+$/, ""))
    .optional(),
  // `PIPELINE_MODE=cloud-tasks`: the queue, and the account whose OIDC token tasks carry.
  TASKS_QUEUE: z.string().min(1).optional(),
  // Steps that run the sandbox go here, one at a time: checks share the bucket mounts.
  TASKS_SANDBOX_QUEUE: z.string().min(1).optional(),
  TASKS_SA_EMAIL: z.string().min(1).optional(),
  // `SANDBOX_MODE=cloud-run-job`: the job and the buckets mounted at /mnt/in and /mnt/out.
  SANDBOX_JOB: z.string().min(1).optional(),
  SANDBOX_IN_BUCKET: z.string().min(1).optional(),
  SANDBOX_OUT_BUCKET: z.string().min(1).optional(),
  // `BLOB_BACKEND=gcs`.
  JOBS_BUCKET: z.string().min(1).optional(),
  // `VAULT_BACKEND=kms`: full key resource name.
  KMS_KEY: z.string().min(1).optional(),
  // `HOUSE_RUNNERS=cloud-run-job`: the honest and the double agent's Cloud Run Jobs.
  HOUSE_RUNNER_JOB: z.string().min(1).optional(),
  HOUSE_RUNNER_DOUBLE_AGENT_JOB: z.string().min(1).optional(),
  BLOB_BACKEND: z.enum(["local", "gcs"]).default("local"),
  BLOB_LOCAL_DIR: z.string().default(".data/blobs"),
  PIPELINE_MODE: z.enum(["inline", "cloud-tasks"]).default("inline"),
  SANDBOX_MODE: z.enum(["docker", "cloud-run-job"]).default("docker"),
  SANDBOX_IMAGE: z.string().default("sideagent-sandbox-python:dev"),
  // Host-side cap on one check run; run_checks.py enforces the per-category timeouts itself.
  SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  GCP_PROJECT: z.string().default("demo-sideagent"),
  // Set by `firebase emulators:exec`; the `dev` script points it at `pnpm emulators`. Unset,
  // HQ uses the real Firestore of GCP_PROJECT.
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  // Same for the Auth emulator, which issues mission control's sign-in tokens; unset, real
  // Firebase Auth verifies them.
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  // Mission control's origin, allowed by CORS on the owner API.
  CONTROL_ORIGIN: z.string().default("http://localhost:3000"),
  CLAIM_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  CLAIM_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Honours `same_owner` on claim and long-poll, for the dev command executor (D18). Off in
  // production, so a runner cannot claim its own owner's jobs; the `dev` script turns it on.
  ALLOW_SAME_OWNER: z.stringbool().default(false),
  // Credit amounts (D24).
  STARTING_CREDITS: z.coerce.number().int().nonnegative().default(100),
  STAKE_PERCENT: Percent.default(20),
  TIMEOUT_SLASH_PERCENT: Percent.default(50),
  // House runners (D20): `local` starts the field CLI as a child process per job.
  HOUSE_RUNNERS: z.enum(["off", "local", "cloud-run-job"]).default("off"),
  // Runner key from `pnpm --filter @sideagent/hq seed`; Secret Manager in Phase 7 (D17).
  HOUSE_RUNNER_API_KEY: z.string().min(1).optional(),
  HOUSE_RUNNER_MODEL_BACKEND: ModelBackendName.default("vertex"),
  HOUSE_RUNNER_MODEL: z.string().min(1).optional(),
  // Grace period before a house runner is started for a newly opened job, so an outside field
  // agent online can claim it first (D27).
  HOUSE_RUNNER_DELAY_SECONDS: z.coerce.number().int().nonnegative().default(10),
  HOUSE_RUNNER_MAX: z.coerce.number().int().positive().default(2),
  // Passed to house runners as SIDEAGENT_MAX_TOKENS (D32).
  HOUSE_RUNNER_MAX_TOKENS: z.coerce.number().int().positive().default(200_000),
  // Demo double agent (Phase 5): dispatched instead of the honest runner, with its own key.
  HOUSE_RUNNER_DOUBLE_AGENT: z.stringbool().default(false),
  HOUSE_RUNNER_DOUBLE_AGENT_API_KEY: z.string().min(1).optional(),
  // Platform agents (screener, trap writer, result screener): triage, then escalate below
  // ESCALATE_BELOW confidence. Same project and location variables as the field CLI.
  PLATFORM_MODEL_BACKEND: z.enum(["vertex", "gemini-api"]).default("vertex"),
  MODEL_TRIAGE: z.string().min(1).default("gemini-2.5-flash-lite"),
  MODEL_ESCALATE: z.string().min(1).default("gemini-2.5-flash"),
  ESCALATE_BELOW: z.coerce.number().min(0).max(1).default(0.8),
  GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default("global"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  // Held with the budget on post; paid to platform fees once screening runs (D30).
  SCREENING_FEE: z.coerce.number().int().nonnegative().default(1),
  // Trap failures before a runner is burned (D29).
  TRAP_BURN_AFTER: z.coerce.number().int().positive().default(1),
  // Test review (D31): mutants of the reference solution per job, and the strength score below
  // which the poster gets a fix hint.
  LIMIT_MUTANTS: z.coerce.number().int().min(1).max(50).default(12),
  // Spend caps (D32): posts per owner per UTC hour, posts platform-wide per UTC day, and
  // submissions per job over all its claims.
  LIMIT_POSTS_PER_HOUR: z.coerce.number().int().positive().default(10),
  LIMIT_POSTS_PER_DAY: z.coerce.number().int().positive().default(40),
  LIMIT_CHECKS_PER_JOB: z.coerce.number().int().positive().default(6),
  TEST_STRENGTH_MIN: Percent.default(60),
  REDACTOR_BACKEND: z.enum(["pattern", "dlp"]).default("pattern"),
  VAULT_BACKEND: z.enum(["local", "kms"]).default("local"),
  // Local vault key: base64 of 32 bytes. Without it, one is generated into VAULT_LOCAL_KEY_FILE.
  VAULT_LOCAL_KEY: z.string().min(1).optional(),
  VAULT_LOCAL_KEY_FILE: z.string().default(".data/vault.key"),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse(env);
}

type OptionalKey = {
  [K in keyof Config]-?: undefined extends Config[K] ? K : never;
}[keyof Config];

/** A variable `mode` can't run without; throws at startup with the mode that needs it. */
export function required<K extends OptionalKey>(
  config: Config,
  name: K,
  mode: string,
): NonNullable<Config[K]> {
  const value = config[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${mode} needs ${name}`);
  }
  return value as NonNullable<Config[K]>;
}
