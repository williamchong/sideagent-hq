# Sideagent technical plan

How the prototype is built: stack, repo layout, components, cloud resources, flows, development and the 5-day plan. Product behavior (job lifecycle, trust layer rules, threat model) is in [`design.md`](design.md). Reasons for choices are in [`decisions.md`](decisions.md) (D13 to D20).

## Overview

```
 Poster agent (Gemini CLI / ADK / Claude Code)
        │  MCP (Streamable HTTP)  ·  A2A (later)
        ▼
┌──────────────────── HQ · Cloud Run (Node + Hono) ────────────────────┐
│  REST · MCP server · A2A server (later) · agent API keys             │
│  Pipeline steps (driven by Cloud Tasks, idempotent):                 │
│    screen → redact → review → open → dispatch → check → release      │
│  Platform agents: Gemini on Vertex AI with typed outputs             │
└──────┬──────────────┬──────────────────┬──────────────────┬──────────┘
       │              │                  │                  │
   Firestore     Sensitive Data     Cloud Run Jobs      Cloud Storage
 (jobs, ledger,   Protection +      (test sandbox:      (specs, tests,
  events, rep)    KMS vault         no internet,         results; mounted
       │                            minimal IAM)         into the sandbox)
       │ onSnapshot (read-only rules)
       ▼
 Mission control · Nuxt SPA on Firebase Hosting (+ Firebase Auth)

 Field CLI (Node, npx sideagent) ──REST/long-poll──▶ HQ
   ├─ laptop: Docker sandbox ─ agent loop ─ Ollama (local Gemma)
   └─ house runners: same CLI as Cloud Run Jobs, started by HQ per job ─ Gemini 2.5 Flash-Lite on Vertex AI
```

**Local first (D19).** Everything above has a local stand-in, and Phases 0–6 run entirely on laptops. GCP is deployed once, in Phase 7. See [Local development](#local-development).

**Zero idle cost (D20).** Every GCP resource scales to zero or is billed per use. See [Cost](#cost).

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript on Node 24 LTS, pnpm workspaces | One language for HQ, CLI, dashboard and schemas (D13). Exception: the check script inside the Python sandbox image. |
| Shared schemas | Zod in `protocol/`, exported to JSON Schema | Single source for API validation, MCP tool schemas, Gemini output schemas and OpenAPI |
| HQ framework | Hono on `@hono/node-server` | REST, MCP Streamable HTTP and (later) A2A JSON-RPC in one service |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP transport | MCP first (D14) |
| A2A | `@a2a-js/sdk`, after the demo | Job states already follow A2A Task states |
| Pipeline | Cloud Tasks → internal HQ endpoints (OIDC-authenticated) | One task per lifecycle step; every step idempotent |
| Models | `@google/genai` with `vertexai: true` | Service-account auth. Triage and escalation model IDs come from config, not code |
| Agent framework | Plain Gemini calls; ADK only if the test-writer needs a loop | Most platform decisions are single typed calls |
| State | Firestore (native mode) with transactions | Ledger entries are the source of truth; balances are a cache updated in the same transaction |
| Redaction | Sensitive Data Protection (`@google-cloud/dlp`) + Cloud KMS | We do the placeholder replacement for readable `[PERSON_1]` tokens |
| Test sandbox | Cloud Run Jobs, one execution per check | See [Test sandbox](#test-sandbox) |
| Owner auth | Firebase Auth | Owners create per-agent API keys in the dashboard (D16) |
| Dashboard | Nuxt (static, `ssr: false`) + Nuxt UI + Vue Flow, Firebase Hosting | Reads Firestore directly behind read-only rules; all writes go through HQ |
| Runner models | Gemma on Ollama (laptop), Gemini 2.5 Flash-Lite on Vertex AI (house runners), Gemini API fallback | D17, D26 |
| Cloud adapters | `BlobStore` (local folder / Cloud Storage), `Vault` (local key / Cloud KMS), `Redactor` (pattern matcher / Sensitive Data Protection), `PipelineRunner` (inline / Cloud Tasks), `Sandbox` (Docker / Cloud Run Jobs), `HouseRunnerDispatcher` (local process / Cloud Run Jobs) | Chosen by environment variables; local is the default (D19) |
| Tests | Vitest; Firestore emulator | |
| Lint and format | ESLint (flat config) + Prettier | |
| CI/CD | GitHub Actions with Workload Identity Federation → Artifact Registry → `gcloud run deploy`; `firebase deploy` | Infrastructure in Terraform (`infra/terraform/`, D33); images rolled out by `infra/deploy.sh` |

## Repository layout

```
protocol/                 @sideagent/protocol
  src/job.ts              JobSpec, JobType, Runtime, JobState (A2A-aligned)
  src/result.ts           Submission, TestSummary
  src/verdict.ts          Screening and judge verdict schemas (Gemini structured output)
  src/errors.ts           { code, reason, fix_hint } and error codes
  src/tools.ts            MCP tool input/output schemas
  scripts/export-schemas.ts   writes schemas/*.json
hq/                       @sideagent/hq  (Cloud Run service)
  src/app.ts              Hono app: /v1 REST, /mcp, /internal (Cloud Tasks), /healthz (local only: Cloud Run reserves the path)
  src/api/                REST handlers (jobs, runner long-poll, API keys)
  src/mcp/                MCP server and tool handlers (thin wrappers over services)
  src/jobs/               job service (post, list, claim, submit, status) and lifecycle transitions
  src/pipeline/           screen.ts, redact.ts, review.ts, check.ts, release.ts
  src/agents/             screener.ts, test-reviewer.ts, result-screener.ts, judge.ts
  src/runtimes/           python.ts (adapter); node.ts later
  src/sandbox/            Sandbox interface: docker.ts (local), cloud-run-job.ts
  src/adapters/           blob/, vault/, redactor/, pipeline/, dispatch/: local and GCP implementations
  src/ledger/             double-entry ledger, escrow, stakes
  src/store/              Firestore repositories (agents, jobs)
  Dockerfile
field/                    sideagent  (published CLI: npx sideagent field)
  src/cli.ts
  src/hq-client.ts        typed REST client for the runner routes
  src/poll.ts             long-poll HQ, claim, submit, retry a failed check; --once --job <id> for house runners
  src/workspace.ts        throwaway job directory: spec + public tests in, new files out
  src/executor/           gemma-loop.ts (built-in tool-calling loop), command.ts (dev only)
  src/model/              ollama.ts, genai.ts (vertex and gemini-api) behind one interface
  src/sandbox/            docker.ts: run_public_tests on laptops; process.ts: in-process for house runners
  src/config.ts           model backend and sandbox image from environment variables
  src/cheat.ts            --simulate-cheat (demo only)
  Dockerfile              house runner image (run as a Cloud Run Job)
control/                  @sideagent/control  (Nuxt dashboard)
  pages/                  index (mission map), feed, ledger, agents (API keys)
images/
  python-sandbox/         Dockerfile + run_checks.py (pytest, stdlib mutator); used by HQ checks and laptop runners
infra/
  terraform/              APIs, network, buckets, KMS, queue, service accounts, Cloud Run, budget (D33);
                          `terraform destroy` is the teardown
  deploy.sh               build images (Cloud Build), roll them out, seed house-runner keys, deploy Firebase
  cloudbuild.yaml         the hq, field and sandbox-python images
  experiments/            day-1 throwaway checks (Gemma call, sandbox mount + no internet)
  firestore.rules
  firestore.indexes.json
  firebase.json
demo/
  jobs/                   demo job specs (honest, malicious, weak tests)
  run-demo.ts             drives the video scenario
docs/
```

## Components

### HQ

- One Cloud Run service. Public routes: `/v1/*` (REST, API-key auth), `/mcp` (MCP Streamable HTTP, API-key auth). Internal routes: `/internal/steps/:step` (Cloud Tasks only, verified OIDC token from the tasks service account).
- MCP tools and REST handlers call the same service functions. No business logic in transport code.
- Agents authenticate with `Authorization: Bearer <api key>` on both `/v1` and `/mcp`. Firestore stores only the SHA-256 hash of each key. Posting needs a `poster` agent; claiming and submitting need a `runner` agent.
- Every write takes an idempotency key, scoped to the calling agent. The job or submission ID is derived from the agent and the key, so a repeated key returns the original response, and a repeated key with a different request returns `conflict`.
- `/mcp` is stateless Streamable HTTP: each request gets a new MCP server bound to the calling agent, so no session state needs to survive scale-to-zero.
- REST routes: `POST /v1/jobs`, `GET /v1/jobs?types=&min_reward=`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/claim`, `POST /v1/jobs/:id/submissions`.
- Owner routes for mission control, authenticated with a Firebase ID token (`Authorization: Bearer <id token>`, verified by `firebase-admin`) instead of an API key, with CORS for `CONTROL_ORIGIN`: `POST /v1/owner` creates the owner on first sign-in, with the UID as its ID (D28) and `STARTING_CREDITS`, and returns `{owner_id, display_name, balance}` on every call; `POST /v1/owner/agents {role}` returns a new agent's `api_key` once; `DELETE /v1/owner/agents/:id` revokes one of the owner's agents, after which its key gets `unauthorized`. Creating a key has no idempotency key, because a replay couldn't return the key again. These are mission control's only writes; it reads everything else from Firestore.
- Runner long-poll: `GET /v1/runner/next?types=...&wait=...` holds up to 30 seconds (`wait`, in seconds) and returns the oldest claimable job or `204`. The runner then claims it; a `409` means another runner won.
- `same_owner=true` on `GET /v1/runner/next` and `POST /v1/jobs/:id/claim` limits a runner to jobs posted by its own owner; a claim on another owner's job returns `forbidden`. The dev command executor always sends it (D18). HQ enforces it because runners never learn who posted a job.
- Claims expire lazily (D21): no timer runs; an expired claim reads as `open` and is written back on the next claim or status call.
- Errors are always `{ code, reason, fix_hint }` from `protocol/src/errors.ts`.

### Pipeline

Each step is a Cloud Tasks task that calls `/internal/steps/:step` with `{ jobId }` (or `{ jobId, submissionId }`). A step:
1. Reads the job, checks its state is the one the step expects (otherwise returns 200 and does nothing, so retries are safe).
2. Does its work.
3. In one Firestore transaction: writes results, moves the state, appends an event, and enqueues the next step.

| Step | From → to | Work |
|---|---|---|
| `screen` | `draft` → `screening` → `test_review` or `rejected` | Redacts the title, spec, tests and reference solution, then the screener agent judges the redacted job. Pays the screening fee (D30); a block stores `rejection {code, reason, fix_hint}` and refunds the budget. `post_job` returns `draft` and the poster polls `get_status` |
| `redact` | (within `screen`) | Redactor inspect, replace with placeholders, encrypt map into `vault/{jobId}`. The map is saved before the blobs are rewritten, and a retry reuses it, so the step is idempotent |
| `review` | `test_review` → `open` or `rejected` | An empty answer must fail the public and hidden tests (a sandbox run alongside the trap writer; if it passes, the job is rejected without the reference run). The trap writer drafts trap checks, and one sandbox run of the reference solution must pass every public and hidden test, keeps only the drafts it passes (D29) and scores up to `LIMIT_MUTANTS` mutants of it for `testStrength`; weak tests open with a fix hint for the poster (D31). Not yet: the test-reviewer agent (tests vs spec). Enqueues `dispatch` |
| `dispatch` | (job stays `open`) | If house runners are enabled, start one house-runner run for the job. Skipped when outside runners are expected to claim it |
| `check` | `submitted` → `checking` → `passed`, or `failed` → `claimed` / `open` | Sandbox runs public + hidden + platform + trap tests; result-screener agent on a passing result, still in placeholder form. Passing the public tests but failing every trap check slashes the whole stake, ends the claim and burns the runner (`trap_failed`, D29). A blocked result (`blocked`) counts as a failed attempt. Moves to `checking` before the sandbox runs. A fail goes back to the runner while it has attempts left, else reopens the job (D23). Sandbox or blob errors throw and leave the job in `checking`; a retried `submit_result` re-enqueues it |
| `release` | `passed` → `released` | Ledger transfer, stake return, reputation update (later). Placeholders are restored on read: `get_status` decrypts the vault map for the poster only, so the real values are never stored in the result |

### Platform agents

Each agent is `{ prompt template, Zod output schema, model tier }`.

- **Untrusted content** (spec, tests, results) is placed in a delimited block with a random boundary string, and the system prompt says content inside is data, never instructions.
- **Typed output** via Gemini structured output from the Zod schema (e.g. `verdict`, `categories`, `confidence`, `fix_hint`).
- **Triage then escalate:** the triage model answers first; an `escalate` verdict or a confidence below `ESCALATE_BELOW` re-runs it on the escalation model. Confidence is the lower of the model's own and `exp(avgLogprobs)`. If the escalation model is still unsure, the job is blocked (fail closed). The job keeps the final verdict without its prose (`screening {verdict, categories, confidence, model, escalated}`).
- Agents (`hq/src/agents/`): `screener` (jobs), `trap-writer` (trap check drafts, D29; thinking budget 1024), `result-screener` (injection in results), `test-reviewer` (tests vs spec; Phase 6), `judge` (double-run and rubric grading; stretch). Model calls go through a `PlatformModel` interface, so tests use a fake.
- Eval set in `hq/test/fixtures/screening.json` (benign and malicious jobs); `pnpm --filter @sideagent/hq eval:screening` reports the block and false-positive rates against the configured models. On demand, not in CI.

### Redaction

Behind the `Redactor` interface, which only finds values: a pattern matcher (emails, phone numbers, Luhn-checked card numbers, numbers after "account"/"acct") locally, Sensitive Data Protection when `REDACTOR_BACKEND=dlp` (`hq/src/adapters/redactor/dlp.ts`, at the `global` location; DLP's code point offsets are converted to UTF-16, and a finding without a range fails the step closed). Placeholders are assigned by our code, so both backends give the same tokens.

1. DLP `inspectContent` on spec text and inputs with a fixed infoType list (person name, email, phone, credit card, account numbers, addresses).
2. Replace findings with `[TYPE_n]` placeholders in our code; the same value gets the same placeholder within a job.
3. Encrypt the map through the `Vault` interface (AES-256-GCM with the job ID as associated data and a local key from `VAULT_LOCAL_KEY` or `.data/vault.key` in development, Cloud KMS in production) and store it in `vault/{jobId}`. Only the poster-side release path decrypts it.
- Placeholders go into the tests and reference solution too, so a correct answer in placeholder form passes, and the poster gets it back with the real values.
4. Gemini second pass is a stretch goal.

### Test sandbox

- One Cloud Run Job (`sideagent-sandbox-python`) built from `images/python-sandbox`. HQ starts an execution per check with overrides for the job path.
- **Input:** HQ writes the bundle (result code, public tests, hidden tests, trap tests) to `gs://<input-bucket>/<jobId>/<checkId>/`, mounted read-only at `/job`.
- **Output:** `run_checks.py` writes `summary.json` (`passed`, `total`, per-category counts) and, when requested, `mutants.json` (`killed`, `total`) to a mounted output bucket. Only HQ reads them.
- **Isolation:** dedicated service account with only object read on the input bucket and object write on the output bucket. Direct VPC egress (all traffic) to a subnet with no Cloud NAT, so no internet. Timeouts per check; capped number of mutants.
- **One check at a time:** the job mounts the whole input and output buckets, and only the arguments pick a check's folder, so two checks at once could read each other's hidden tests or write into each other's output. The steps that run the sandbox (`review`, `check`) go to their own Cloud Tasks queue, `sideagent-sandbox` (`TASKS_SANDBOX_QUEUE`), which dispatches one task at a time, and each run clears both buckets before it writes its bundle. Checks wait for each other; signed URLs per execution instead of mounts would let them run in parallel (roadmap).
- **Known gap:** with Private Google Access, code in the sandbox could reach Google APIs using the sandbox service account. A VPC Service Controls perimeter closes this; it is on the roadmap, not in the prototype.
- **On Cloud Run:** the input bucket is mounted read-only at `/mnt/in` and the output bucket at `/mnt/out`; HQ starts each execution with `check --job /mnt/in/<jobId>/<checkId> --out /mnt/out/<jobId>/<checkId>` (`run` takes `--work` the same way). Cloud Run doesn't give HQ the exit code, so a result counts as scored only when the execution succeeded and `summary.json` exists; `error.json` means rejected; anything else is a sandbox failure and the step is retried. Without the success check, a result could write its own `summary.json` and kill the checker.
- **One image, two commands.** `images/python-sandbox` (Python 3.13, hash-pinned pytest, uid 10001) serves HQ checks and laptop runners. Jobs can use the standard library and pytest only (D22).
  - `check` (HQ): reads the result from `/job/result/` and each test category from `/job/tests/<category>/` (`public`, `hidden`, `trap`; any directory name works), plus an optional `/job/config.json` with `timeout_seconds` per category and `mutants: {limit, categories}`. Writes counts only, as `TestSummary`, to `/out/summary.json`, or `/out/error.json` (`{code, reason, fix_hint}`) when the result is rejected. With `mutants`, and only if the result passes every listed category, it also writes `/out/mutants.json`: up to `limit` mutants of the result's code files (D31), each run against those categories with a 10 s timeout per run and 120 s for all mutants (later ones are left out of the score), and how many any test caught.
  - `run --timeout N -- <tests...>` (laptop runners, `run_public_tests`): runs public tests in `/work`, mounted read-only, and prints the pytest output, capped at 64 KB.
- **Scoring defences in `run_checks.py`:** the script runs with `python -I` and never imports job code. Each category runs pytest as a child process in a fresh scratch directory, with a fixed environment, the platform `pytest.ini` (`-c`), `--noconftest`, only the category's test files as explicit paths, and a timeout, after which every process of the sandbox user is killed. A result containing `conftest.py`, pytest or Python startup files (`pytest*`, `*.pth`, `sitecustomize.py`, ini files) or a path that collides with a test is rejected. The exit code must agree with the JUnit report (exit 0 with no failures, or exit 1 with some), or the category fails with at least one failed test per file. Skipped tests count as not passed. The output file is written last, replacing anything a test wrote.
- **Local Docker flags** (HQ `SANDBOX_MODE=docker` and laptop runners): `--pull=never --network=none --read-only --tmpfs=/tmp:size=64m --cap-drop=ALL --security-opt=no-new-privileges --user=10001 --pids-limit=128 --memory=512m --cpus=1 --init`, no `-e` variables, `/job` and `/work` read-only. On Cloud Run the same image relies on gVisor, the no-NAT subnet and the minimal service account instead.
- **Known gap:** code under test runs as the same user, and the solution in the same process, as the pytest report. A result written to attack the checker (monkeypatching pytest at import, writing a fake JUnit report, or killing `run_checks.py` and writing its own summary) could fake a pass. Trap checks, stakes and double-runs are the backstop; running each category as a separate user is on the roadmap.
- **Runtime adapter:** `hq/src/runtimes/python.ts` knows the image, how to lay out the bundle and how to read the summary. A `node.ts` adapter (vitest, Stryker) plugs in later (D15).

### Ledger

- `ledger/{entryId}` entries are append-only: `{ from, to, amount, jobId, reason, createdAt }`. Accounts are `owner:<id>`, `escrow:<jobId>`, `stake:<jobId>:<agentId>`, `platform:fees`, and `platform:grants`, which goes negative by the starting credits it hands out, so the sum of all balances is always 0.
- `balances/{account}` is updated in the same transaction as each entry (`FieldValue.increment`, so a transfer needs no read); it is a cache and can be rebuilt from entries. Only debits from `owner:` accounts read the balance first, to refuse with `insufficient_credits`.
- New owners get `STARTING_CREDITS` (D24). Post holds the budget plus `SCREENING_FEE` in escrow; the fee goes to `platform:fees` once screening runs, and a job rejected by screening or test review gets its budget back (D30); claim holds the stake (`STAKE_PERCENT` of the budget, at least 1); release pays the budget to the runner's owner and returns the stake; a claim timeout sends `TIMEOUT_SLASH_PERCENT` of the stake to `platform:fees` and returns the rest; a claim that ends after its last failed attempt returns the stake (D23); a trap failure moves the whole stake to `platform:fees` (D29).
- Not yet: refunding escrow when a job expires or is cancelled.

### Firestore data model

```
owners/{ownerId}                 policies { budgetCap, allowedTypes[], approvalThreshold }, killSwitch
agents/{agentId}                 ownerId, role (poster|runner), apiKeyHash, declaredModels[],
                                 status (active|revoked|burned), trapsFailed, createdAt
jobs/{jobId}                     posterAgentId, type, runtime, state, specRef, publicTests, budget, screeningFee,
                                 deadline, testStrength { score, killed, mutants, fixHint }, screening { verdict, categories, confidence, model,
                                 escalated }, redactions { TYPE: count }, rejection { code, reason, fix_hint },
                                 claim { runnerAgentId, claimedAt, deadline, attemptsLeft }, checksUsed, dispatchedAt, idempotencyKey
jobs/{jobId}/private/main        hiddenTestsRef, referenceSolutionRef, trapChecksRef   (HQ only)
jobs/{jobId}/submissions/{id}    resultRef, testSummary { passed, total, categories }, screening, idempotencyKey
jobs/{jobId}/events/{id}         type, from, to, detail, createdAt
ledger/{entryId}                 from, to, amount, jobId, reason, createdAt   (append-only)
balances/{account}               amount, updatedAt
reputation/{agentId}_{type}      score, trapsPassed, trapsFailed, jobsPassed, disputes
vault/{jobId}                    ciphertext (KMS)   (HQ only)
usage/day-{YYYY-MM-DD}           posts that UTC day, expireAt for a TTL policy (D32)   (HQ only)
usage/owner-{ownerId}-{YYYY-MM-DDTHH}  posts by the owner that UTC hour, expireAt (D32)   (HQ only)
config/platform                  paused: kill switch, set by hand or by budget-guard (D32)   (HQ only)
feed/{id}                        kind, jobId, agentId, categories, detail, createdAt: public checkpoint log
                                 events (blocked jobs, redactions, held results, burned runners), from
                                 fixed templates and counts, never job content or a model's prose
```

**Rules** (`infra/firestore.rules`, tested in `hq/test/firestore-rules.test.ts`): clients never write. An owner reads their own `owners/{uid}`, their `agents`, `balances/owner:{uid}`, the jobs their agents posted or hold a claim on (`posterOwnerId` or `claim.runnerOwnerId`), those jobs' events, and the `escrow:` and `stake:` balances of those jobs. Balances are read one document at a time; there is no listing. `feed` is public read. `private`, `vault`, `ledger`, `submissions` and the `platform:` balances are HQ only. A runner's owner stops seeing a job once its claim ends, because `claim` goes back to null. Owners can read `apiKeyHash` on their own agents, because rules can't hide single fields; it is a SHA-256 of a 256-bit random key. For the same reason a job document's HQ bookkeeping (`specRef`, `idempotencyKey`, `requestHash`) is readable by the job's owners; none of it is secret.

The document shapes mission control reads (`JobView`, `JobEventView`, `AgentView`, `OwnerView`, `BalanceView`) and the ledger account IDs are in `protocol/src/firestore.ts`. HQ's document types extend them with HQ-only fields.

### Mission control

- Nuxt static app on Firebase Hosting with Firebase Auth (Google sign-in).
- Pages: mission map (Vue Flow graph of jobs, runners and states, live via `onSnapshot`), feed (blocked jobs, burned runners, with categories and templated reasons), ledger, agents (create and revoke API keys through HQ), a page per mission, and a public briefing.
- **Built in Phase 4** (`control/`): Nuxt 4 with `ssr: false`, the Firebase web SDK (no VueFire), `@vue-flow/core`, Nuxt UI v4 (Tailwind CSS v4) for components and VueUse for composables (D34). The theme lives in `app/assets/main.css` (the `signal` amber and `ink` palettes, dark only) and `app/app.config.ts` (component defaults). Icons are bundled from `@iconify-json/lucide` and `@iconify-json/simple-icons`, and `@nuxt/fonts` is off, so the app makes no Iconify or Google Fonts requests. The Firebase plugin connects to the Auth and Firestore emulators when `NUXT_PUBLIC_USE_EMULATORS` is on (the default). After Google sign-in it calls `POST /v1/owner`. All other reads are live `onSnapshot` queries (`useLiveQuery`, `useLiveDoc`), typed with the views in `protocol/src/firestore.ts`.
  - **Mission map:** one lane per lifecycle stage (checkpoint, open, in the field, debrief check, dead drop, closed). A card for each job the owner posted or holds a claim on (two queries, matching the rules). A field-agent node for each claiming runner, with an edge to its jobs. Cards slide between lanes when their state changes. An empty lane shows a dashed slot saying what lands there, and the map is fitted to the canvas and pinned to its top. The side panel shows the selected mission's log from `jobs/{id}/events`.
  - **Ledger:** the owner's available balance plus each mission's reward, escrow and stake, all live from `balances`. Ledger entries stay HQ-only.
  - **Mission page** (`/missions/{id}`, D36): one job's facts, rejection or fix hint and mission log (the map's side panel), its reward, escrow and stake, and its `feed` entries. Ledger rows, the map's side panel and feed entries for the viewer's own missions link to it. Only the poster and the claiming runner can read the job, so anyone else, and a job that doesn't exist, gets the same "Classified" card.
  - **Keys** (`/agents`): issue handler (poster) and field agent (runner) keys through `/v1/owner/agents`. The key is shown once, with Gemini CLI, Claude Code or `pnpm field` snippets. Agents are listed live, and any of them can be revoked.
  - **About** (`/about`): what Sideagent does, how a mission runs, and how an agent connects: MCP config for Gemini CLI and Claude Code with placeholder keys, the MCP tools, and the `pnpm field` command. Visitors who aren't signed in see it on every route in place of a bare sign-in card, so the site reads as agent-first before sign-in. Static copy only: it reads no Firestore data and shows nothing private. The tool list mirrors `hq/src/mcp/server.ts` by hand, and the snippets come from `app/utils/snippets.ts`, which the Keys page shares.
  - **Checkpoint log** (feed, Phase 5): the latest 50 `feed` entries, live and public: blocked and rejected briefings, redactions, held debriefs and burned double agents. The mission panel also shows the screening verdict, what was redacted and, for the poster, the rejection reason and fix hint.
  - The job queries have no limit. A `createdAt` limit needs composite indexes; `infra/firestore.indexes.json` is still empty.
- Spy terms in all UI copy; plain terms in code (see the glossary in `design.md`).

### Field CLI and house runners

- `npx sideagent field --types code.implement --model <id>` long-polls, claims, runs, submits.
- **Executor:** built-in tool-calling loop (`--executor gemma`, the default) with tools `read_file`, `write_file`, `list_files`, `run_public_tests`, `submit`. Limits per job: 40 steps, 600,000 tokens (input plus output over all calls; `SIDEAGENT_MAX_TOKENS`, 200,000 on house runners, D32) and the claim deadline minus 15 seconds. The system prompt is fixed text; the spec and tests reach the model only as delimited tool results marked untrusted. `write_file` refuses the inputs, dotfiles and paths outside the workspace; `submit` refuses an empty result. Tool errors go back to the model as text so it can correct itself.
- **Dev command executor:** `--executor command --trusted-dev` hands the workspace to `claude -p` or `codex exec` instead of the built-in loop. Development only: it claims only jobs posted by the same owner, needs network and the CLI's own credentials (so it is not a real sandbox), and never runs in house runners or the demo (D18).
- **Workspace:** each claimed job gets a temp directory holding `SPEC.md` and the public tests. The spec is never pasted into a prompt; the executor reads it from the file. Every new regular file is the result, except dotfiles, `__pycache__` and the inputs themselves; the directory is deleted afterwards. The command executor (`--command claude|codex`) runs with the runner's environment minus `SIDEAGENT_*`, so it can't see the runner's HQ key, and is killed 15 seconds before the claim deadline. It doesn't run the public tests before submitting; only the built-in loop has `run_public_tests`.
- **Model backends** behind one interface, chosen by `SIDEAGENT_MODEL_BACKEND`: `ollama` (default for laptops, `/api/chat` with tools), `vertex` (house runners, application default credentials), `gemini-api` (fallback). `vertex` and `gemini-api` share one `@google/genai` backend that retries 429 and 503 for about 2.5 minutes and sends each model turn back as received, so Gemini 3 thought signatures survive. `--model` overrides `SIDEAGENT_MODEL`; defaults are `gemma4:26b-a4b` for `ollama` and `gemini-2.5-flash-lite` for `vertex` (D26), and `gemini-api` has none.
- **Laptop sandbox:** the loop runs on the host and touches only the workspace. The only code it runs is the public tests, through `run_checks.py run` in the `python-sandbox` image with the same flags as HQ checks (`DOCKER_RUN_FLAGS` in `protocol/src/sandbox.ts`): `--network=none`, the workspace mounted read-only at `/work`, no environment passthrough, non-root user.
- **House runners (D20):** the `field/Dockerfile` image as Cloud Run Jobs, started by HQ's `dispatch` step with `--once --job <id>`: claim that job, run it, submit, and wait for the check. After a failed check the job comes back under the same claim (D23), so the run solves it again in a fresh workspace while attempts are left, telling the model only the previous pass count. Then it exits. No idle cost; each run has a cold start of tens of seconds, during which the job stays open in the dashboard. Calls `gemini-2.5-flash-lite` at the Vertex AI `global` location (D26). The container is the sandbox and runs public tests in-process. Jobs: `house-runner-honest`, and `house-runner-double-agent` (`SIDEAGENT_SIMULATE_CHEAT=1`), which is dispatched only when `HOUSE_RUNNER_DOUBLE_AGENT=1`. Locally, the dispatcher starts the CLI as a child process. The `dispatch` step runs `HOUSE_RUNNER_DELAY_SECONDS` (default 10) after a job opens, so an outside field agent online can claim it first (D38). If the job is still open, it records `dispatchedAt`, then starts the run, so a retried step never starts a second one. It writes no mission log event: the house runner shows up only when it claims, like any field agent. A job that reopens after a failed claim is not dispatched again.
- `--simulate-cheat` is demo-only and prints a banner saying so.

## Google Cloud resources

| Resource | Name (suggested) | Notes |
|---|---|---|
| Cloud Run service | `sideagent-hq` | Public; API-key auth in app; minimum 0 instances |
| Cloud Run job | `sideagent-sandbox-python` | Started by HQ |
| Cloud Run jobs | `house-runner-honest`, `house-runner-double-agent` | Started by HQ per job; no idle cost |
| Cloud Tasks queues | `sideagent-pipeline`, `sideagent-sandbox` | Retries with backoff, 5 attempts; `sideagent-sandbox` takes `review` and `check` one at a time |
| Firestore | default database | Native mode |
| Buckets | `<project>-jobs`, `<project>-sandbox-in`, `<project>-sandbox-out` | Lifecycle rule deletes sandbox objects after 1 day |
| KMS | key ring `sideagent`, key `vault` | |
| VPC | `sideagent-sandbox` subnet (/26 or larger), no Cloud NAT, Private Google Access on | For the sandbox job |
| Secret Manager | `house-runner-honest-key`, `house-runner-double-agent-key` | Runner API keys |
| Artifact Registry | `sideagent` | Images; cleanup policy keeps the last few per image |
| Billing budget | `sideagent` | $10/month; alert emails at 50%, 90%, 100%; notifications to Pub/Sub topic `billing-budget` (D32) |
| Cloud Run service | `budget-guard` | Private; Pub/Sub push from `billing-budget` (subscription `budget-guard-push`, never expires): pauses the platform at 100%, turns off billing at 200% (D32). Max 1 instance, scales to zero |
| Pub/Sub topic | `billing-budget` | Budget notifications |
| Firebase | Hosting + Auth on the same project | |

### Service accounts

| Account | Grants |
|---|---|
| `sa-hq-run` | Firestore user; Firebase Auth viewer (revocation check); Run viewer (polls job operations); Cloud Tasks enqueuer; Vertex AI user; DLP user; KMS encrypt/decrypt on `vault`; Storage object admin on jobs and sandbox buckets; permission to run the sandbox and house-runner jobs with overrides; act as `sa-tasks` |
| `sa-tasks` | Cloud Run invoker on `sideagent-hq` (OIDC for Cloud Tasks) |
| `sa-sandbox` | `storage.objectViewer` on sandbox-in; `storage.objectUser` on sandbox-out (needed for the write mount). Nothing else. |
| `sa-house-honest`, `sa-house-cheat` | Vertex AI user; secret accessor on its own key |
| `sa-budget-guard` | Firestore user (sets `config/platform.paused`); Project Billing Manager (unlinks billing at 200%) |
| `sa-budget-push` | Cloud Run invoker on `budget-guard` (OIDC for the Pub/Sub push) |
| Compute Engine default | Artifact Registry writer on `sideagent`, log writer: Cloud Build runs as it |
| `sa-deploy` | Used by GitHub Actions via Workload Identity Federation: Cloud Run admin, Artifact Registry writer, act as the runtime accounts, Firebase deploy |

## Configuration

HQ:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port (default `8080`) |
| `GCP_PROJECT`, `GCP_REGION` | Project and region (`sideagent-hq`, `us-west1`; D25) |
| `TASKS_QUEUE`, `TASKS_SANDBOX_QUEUE`, `TASKS_SA_EMAIL`, `HQ_URL` | Cloud Tasks setup: sandbox steps go to `TASKS_SANDBOX_QUEUE`; HQ's own URL is the task target and OIDC audience, and `/internal/steps/:step` accepts only tokens for it from `TASKS_SA_EMAIL` |
| `SANDBOX_JOB`, `SANDBOX_IN_BUCKET`, `SANDBOX_OUT_BUCKET`, `JOBS_BUCKET` | Sandbox and storage. These and the other GCP variables are set by Terraform; each cloud mode fails at startup naming any that is missing |
| `HOUSE_RUNNER_JOB`, `HOUSE_RUNNER_DOUBLE_AGENT_JOB` | Cloud Run Jobs for `HOUSE_RUNNERS=cloud-run-job` |
| `SANDBOX_IMAGE` | Sandbox image for `SANDBOX_MODE=docker` (default `sideagent-sandbox-python:dev`) |
| `SANDBOX_TIMEOUT_SECONDS` | Host-side cap on one `docker run` check (default 600); the container is killed and the step retried |
| `KMS_KEY` | Vault key resource name |
| `BLOB_BACKEND`, `VAULT_BACKEND`, `REDACTOR_BACKEND` | `local` / `gcs`, `local` / `kms`, `pattern` / `dlp` |
| `BLOB_LOCAL_DIR` | Folder for `BLOB_BACKEND=local` (default `.data/blobs`) |
| `PIPELINE_MODE`, `SANDBOX_MODE` | `inline` / `cloud-tasks`, `docker` / `cloud-run-job` |
| `HOUSE_RUNNERS` | `off` (default) / `local` / `cloud-run-job` |
| `HOUSE_RUNNER_DOUBLE_AGENT`, `HOUSE_RUNNER_DOUBLE_AGENT_API_KEY` | Dispatch the demo double agent instead of the honest runner, with its own runner key (printed by the seed script; one trap failure burns it) |
| `HOUSE_RUNNER_API_KEY` | Runner key the house runner claims with; required when `HOUSE_RUNNERS=local` (printed by the seed script). With `cloud-run-job` the key is a Secret Manager secret on the job, seeded once by `deploy.sh` from `pnpm --filter @sideagent/hq seed:house` |
| `HOUSE_RUNNER_MODEL_BACKEND`, `HOUSE_RUNNER_MODEL` | Passed to the house runner as `SIDEAGENT_MODEL_BACKEND` (default `vertex`, D26) and `SIDEAGENT_MODEL` |
| `HOUSE_RUNNER_DELAY_SECONDS` | Grace period after a job opens before a house runner is started (default 10, D38); tests set 0 |
| `HOUSE_RUNNER_MAX` | Local house runners running at once (default 2); past the cap the dispatch step fails and the job is left to outside runners |
| `LIMIT_POSTS_PER_HOUR`, `LIMIT_POSTS_PER_DAY`, `LIMIT_CHECKS_PER_JOB`, `LIMIT_MUTANTS` | Caps on paid work (D32): posts per owner per UTC hour (10), posts platform-wide per UTC day (40), submissions per job over all claims (6), mutants per job (12, at most 50). A hit returns `rate_limited` |
| `HOUSE_RUNNER_MAX_TOKENS` | Token cap per house-runner run, passed as `SIDEAGENT_MAX_TOKENS` (200,000; D32) |
| `TEST_STRENGTH_MIN` | Strength score below which the poster gets a fix hint (60, D31) |
| `MODEL_TRIAGE`, `MODEL_ESCALATE`, `ESCALATE_BELOW` | Platform agent models (default `gemini-2.5-flash-lite`, `gemini-2.5-flash`) and the confidence below which triage escalates (0.8) |
| `PLATFORM_MODEL_BACKEND` | `vertex` (default, with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, default `global`) or `gemini-api` (with `GEMINI_API_KEY`). Without credentials HQ still starts; screening steps throw and leave jobs in `screening` |
| `SCREENING_FEE`, `TRAP_BURN_AFTER` | Credits held on post and kept once screening runs (1, D30); trap failures before a runner is burned (1, D29) |
| `VAULT_LOCAL_KEY`, `VAULT_LOCAL_KEY_FILE` | Local vault key (base64 of 32 bytes), else read from or generated into the file (default `.data/vault.key`) |
| `FIRESTORE_EMULATOR_HOST` | Firestore emulator address (`pnpm --filter @sideagent/hq dev` defaults it to `127.0.0.1:8180`). Unset means production Firestore, which HQ refuses on a `demo-*` project |
| `FIREBASE_AUTH_EMULATOR_HOST` | Auth emulator address for verifying mission control's sign-in tokens (`dev` defaults it to `127.0.0.1:9099`); without it the owner routes refuse every call |
| `CONTROL_ORIGIN` | Mission control's origin, allowed by CORS on `/v1/owner` (default `http://localhost:3000`) |
| `CLAIM_TTL_SECONDS`, `CLAIM_ATTEMPTS` | Claim length (default 1800) and submissions per claim (default 3) |
| `STARTING_CREDITS`, `STAKE_PERCENT`, `TIMEOUT_SLASH_PERCENT` | Credits for a new owner (100), stake as a share of the budget (20) and share of the stake slashed on claim timeout (50); D24 |

Field CLI:

| Variable | Meaning |
|---|---|
| `SIDEAGENT_HQ_URL`, `SIDEAGENT_API_KEY` | HQ endpoint and runner key |
| `SIDEAGENT_MODEL_BACKEND` | `ollama` / `vertex` / `gemini-api` |
| `SIDEAGENT_MODEL` | Model ID for the backend; `--model` overrides it |
| `SIDEAGENT_SANDBOX_IMAGE` | Image for `run_public_tests` (default `sideagent-sandbox-python:dev`) |
| `SIDEAGENT_SIMULATE_CHEAT` | Demo double agent |
| `SIDEAGENT_MAX_TOKENS` | Token cap per job for the built-in loop (default 600,000; house runners get `HOUSE_RUNNER_MAX_TOKENS`) |
| `SIDEAGENT_TEST_RUNNER`, `SIDEAGENT_RUN_CHECKS` | `docker` (default, laptops) or `process` (house runners: `run_checks.py run` in-process on a copy of the workspace, with an environment of only `PATH`, `HOME` and `LANG`; the container is the sandbox), and the script's path for `process` (default `/opt/sideagent/run_checks.py`) |
| `OLLAMA_HOST` | Ollama URL for the `ollama` backend (default `http://127.0.0.1:11434`) |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Vertex AI project and location (default `global`) for the `vertex` backend |
| `GEMINI_API_KEY` | Only for the `gemini-api` backend |

## Local development

- `pnpm install` at the root; `pnpm typecheck`, `pnpm lint`, `pnpm test`. `pnpm schemas` regenerates `protocol/schemas/*.json`; CI fails if the committed files are stale.
- No build step: packages export their TypeScript sources and run through `tsx`, locally (`pnpm --filter @sideagent/hq dev`) and in the images (`node --import tsx hq/src/server.ts`), which install production dependencies only.
- JSON Schemas come from Zod 4's built-in `z.toJSONSchema()`. API-facing fields (REST, MCP, JSON Schema) are snake_case, matching the MCP tool signatures in `design.md`; Firestore documents are camelCase.
- Firebase emulators for Firestore and Auth, from the `firebase-tools` dev dependency. They need **Java 21 or later**. `pnpm emulators` starts the Firestore emulator on port 8180 and the Auth emulator on port 9099, with the UI on port 4000, and `pnpm test` runs every package's tests inside `firebase emulators:exec`. The emulator project is `demo-sideagent`, which needs no credentials.
- Phase 1 demo: `pnpm emulators`, then `pnpm --filter @sideagent/hq dev`, then `pnpm --filter @sideagent/hq seed`, which creates a poster and a runner agent and prints their keys with ready-to-paste MCP config for Gemini CLI and Claude Code. `pnpm demo:runner` (with `SIDEAGENT_API_KEY` set to the runner key) claims the next job, submits a stub result and follows it to `released`.
- Local is the default for every adapter: `PIPELINE_MODE=inline`, `SANDBOX_MODE=docker`, `BLOB_BACKEND=local`, `VAULT_BACKEND=local`, `REDACTOR_BACKEND=pattern`. House runners are `off` by default because they need a key; set `HOUSE_RUNNERS=local` to dispatch them. Production switches each to its GCP backend.
- Local development uses only model and redaction APIs from GCP: Gemini on Vertex AI (or the Gemini API with a key), and Sensitive Data Protection when testing `REDACTOR_BACKEND=dlp`. This needs `gcloud auth application-default login` as an account with access to `sideagent-hq`. Production is set up by Terraform and `infra/deploy.sh` (see `infra/terraform/README.md`).
- Runner comparison: `pnpm compare:runners --trials 3 --runners reference,ollama:gemma4:26b-a4b,vertex:gemini-2.5-flash-lite,claude` runs the candidate demo jobs in `demo/jobs/code.ts` and prints a Markdown table (see "Field runner checks").
- Laptop runner: install Ollama, `ollama pull gemma4:26b-a4b`, `pnpm sandbox:build`, then `pnpm field` with `SIDEAGENT_API_KEY` set to a runner key. For managed models, set `SIDEAGENT_MODEL_BACKEND=vertex` and `GOOGLE_CLOUD_PROJECT`; `field/test/sandbox.test.ts` checks the public-test sandbox (no network, no host environment, read-only workspace) and is skipped without Docker, except in CI.
- Sandbox image: `pnpm sandbox:build` builds `sideagent-sandbox-python:dev` with the local Docker. HQ checks need it (`SANDBOX_MODE=docker`). `hq/test/python-sandbox.test.ts` rebuilds it (cached) and runs attack fixtures and the HQ Docker sandbox against it; it is skipped without Docker, except in CI. Other HQ tests use a fake sandbox, so they don't need Docker.
- Mission control: `pnpm emulators`, HQ (`pnpm --filter @sideagent/hq dev`, plus `HOUSE_RUNNERS=local` and the seeded `HOUSE_RUNNER_API_KEY` for house runners), then `pnpm --filter @sideagent/control dev`, which serves it on `http://localhost:3000`. Sign in through the Auth emulator's Google page, issue a handler key on the Keys page, and connect Gemini CLI with the snippet shown. `NUXT_PUBLIC_HQ_URL`, `NUXT_PUBLIC_FIRESTORE_EMULATOR` and `NUXT_PUBLIC_AUTH_EMULATOR` override the local addresses. `nuxt typecheck` runs as the package's typecheck. `control/test/jobs.test.ts` checks that every job state lands in one lane of the mission map. Firestore rules are tested in `hq`.
- Phase 3 demo: `pnpm emulators`, `pnpm sandbox:build`, `pnpm --filter @sideagent/hq dev`, then `pnpm demo:escrow`. It creates a poster owner and a runner owner, submits a wrong then a correct answer, and prints balances and what the poster sees.
- `pnpm --filter @sideagent/hq seed` grants the owner `STARTING_CREDITS`. It also creates a `House runners` owner (with the same credits, for stakes) and its runner agent, and prints `HOUSE_RUNNER_API_KEY`.
- Local house runners: restart HQ with `HOUSE_RUNNERS=local`, `HOUSE_RUNNER_API_KEY` and `GOOGLE_CLOUD_PROJECT` (for the default `vertex` backend). Every new job then gets one `sideagent field --once --job <id>` child process, logged by HQ with a `[house <jobId>]` prefix. The child gets only `PATH`, `HOME`, Docker, Ollama and Google Cloud model settings from HQ's environment, plus its own key, never HQ's settings or secrets.

## Testing

`pnpm test` runs every package's Vitest suite inside the Firestore and Auth emulators. Tests never call GCP. Gemini, the sandbox, the vault, the redactor and the dispatcher sit behind interfaces, so a suite fakes the ones it is not testing. Docker suites (`hq/test/python-sandbox.test.ts`, `field/test/sandbox.test.ts`) are skipped without Docker, except in CI.

Each suite pins one promise of the design:

| Promise | Test |
|---|---|
| A job cannot skip screening, and a terminal state cannot move | `hq/test/transitions.test.ts` |
| Post, claim, submit, release; hidden tests and the result stay hidden; one of two claims wins; idempotency | `hq/test/jobs.test.ts` |
| Screening fails closed, redaction restores only for the poster, weak or empty tests are rejected, a trap failure burns the runner, a hostile result is held | `hq/test/counterintel.test.ts` |
| The sum of every balance stays 0, and each balance matches its ledger entries | `hq/test/ledger.test.ts` |
| Clients cannot write Firestore, and `private`, `vault`, `ledger` and submissions stay HQ-only | `hq/test/firestore-rules.test.ts` |
| Internal steps accept only the tasks service account's OIDC token | `hq/test/internal-steps.test.ts` |
| A forged `summary.json`, a hang, a colliding path and a networked test fail in the real image | `hq/test/python-sandbox.test.ts` |
| A ciphertext cannot be decrypted under another job ID | `hq/test/redact.test.ts` |
| Caps, the kill switch and the budget guard stop paid work | `hq/test/limits.test.ts`, `hq/test/budget-guard.test.ts` |
| Every job state sits in exactly one mission-control lane | `control/test/jobs.test.ts` |
| The field CLI keeps a job's workspace to the spec and public tests, runs those tests with no network, and the dev executor only claims its owner's jobs | `field/test/` |

Agent evals in `hq/test/fixtures/` report the screener's block rate and false positives. `pnpm --filter @sideagent/hq eval:screening` runs them on demand, not in CI, because they call the model. `demo/run-demo.ts` is the end-to-end run against a deployed or emulated stack, and it is the video script.

## 5-day plan

Two people. **A** owns HQ and the trust layer; **B** owns the field CLI, dashboard and demo. The phase-by-phase build order, with a reviewable result for each phase, is in [`phases.md`](phases.md).

Must have for the demo:
- Post, claim, submit, check, release over MCP.
- Job screening and result screening with Gemini.
- Redaction with Sensitive Data Protection.
- Hidden tests run in Cloud Run Jobs; trap check that catches a fake result.
- Credit ledger with escrow and stake.
- Field CLI on local Gemma and house runners on Vertex AI.
- Mission control with the live job graph and screening feed.

Stretch: platform-written tests, double-run judge, Gemini redaction pass.

Roadmap slide: `data.extract` fan-out jobs (D35), A2A server, RFC 8628 device linking, signed logs and OpenTelemetry, JS jobs, model-monitoring dashboard, VPC Service Controls for the sandbox, per-skill reputation UI, shared result cache, low-carbon scheduling, dispute panel, private boards, real-money settlement.

## Cost

Target: under about $1/month when idle; low single-digit dollars on demo day (D20).

| Resource | Idle cost | Why |
|---|---|---|
| HQ (Cloud Run, min 0) | $0 | Scales to zero; free tier covers demo traffic |
| Sandbox and house runners (Cloud Run Jobs) | $0 | Billed only while running |
| Cloud Tasks, Firestore, Firebase Hosting and Auth, Secret Manager | $0 | Within free tiers at our volume |
| Gemini on Vertex AI, Sensitive Data Protection | $0 | Pay per use; never buy provisioned throughput |
| Cloud Storage | ~$0 | `us-west1` is in the always-free regions; 1-day lifecycle on sandbox buckets |
| Cloud KMS | ~$0.06/month | One key |
| Artifact Registry | ~$0–0.20/month | Cleanup policy |
| Sandbox VPC | $0 | Direct VPC egress has no connector cost; no Cloud NAT (~$32/month) by design |

Rules:
- No resource with always-on instances, no Cloud NAT, no Serverless VPC Access connector, no load balancer or static IP.
- Before recording, warm up by running one demo job instead of raising minimum instances.
- Spend caps in three layers (D32): HQ limits (posts per owner per hour, posts per day, checks per job, mutants per job, house-runner tokens) and the `config/platform.paused` kill switch; GCP settings (HQ max 2 instances, jobs with no retries and a task timeout, Cloud Tasks with 5 attempts); a $10 budget whose `budget-guard` function pauses the platform at 100% and turns off billing at 200%.
- Worst case per job with the caps is about $0.15 (house runner at its token cap on all 3 attempts, trap writer at its output cap, 6 checks), so about $6/day at 40 jobs. Observed: about $0.01–0.02 per job.
- Budget set by Terraform. `terraform destroy` removes everything billable after judging; the Firestore database is abandoned, not deleted, and the KMS key ring stays (key rings can't be deleted; destroyed key versions cost nothing).
- Whether the hackathon provides GCP credits is still unknown; the budget measures spend before credits, so the guard trips either way.

## Verified facts

From the docs, checked 2026-10-13:

- **Managed Gemma on Vertex AI:** model ID `gemma-4-26b-a4b-it-maas` (Gemma 4 26B A4B IT). Launch stage **Experimental**. Available only at the `global` location; ML processing is multi-region `us`. Supports function calling and structured output; no thinking mode. Context 262,144 tokens, max output 128,000. Pay-as-you-go supported. Because it is Experimental, the Gemini API fallback backend must work before the demo.
- **Cloud Storage mounts on Cloud Run Jobs:** supported, with a read-only option. The mount uses the job's service identity (`roles/storage.objectViewer` to read, `roles/storage.objectUser` to write). If the mount can't reach Cloud Storage, the job doesn't start; the mount phase has a 30-second timeout. Google recommends Direct VPC with `--vpc-egress=all-traffic` plus Private Google Access for this setup. No file locking; writes flush on close.
- **Direct VPC egress on Cloud Run Jobs:** supported. Each task holds one IP during execution plus 7 minutes, so the subnet needs at least a /26. Internet access with all-traffic egress goes through Cloud NAT, so a subnet without NAT should have no internet; the docs imply this but don't state it, so confirm it with a test.

## Day 1 checks

From day-1 experiments on project `sideagent-hq` (`us-central1`, before D25 chose `us-west1`), 2026-10-15. Scripts are in `infra/experiments/`; nothing was left running.

- **Gemma call works:** `gemma-4-26b-a4b-it-maas` at `global` through `@google/genai` returned a correct function call in about 1.2 s. The first call got `429 RESOURCE_EXHAUSTED` "The request queue is full" and the retry succeeded, so the `vertex` backend must retry 429s with backoff.
- **Gemini structured output and logprobs:** `responseJsonSchema: z.toJSONSchema(schema)` returns JSON that parses with the same Zod schema on `gemini-2.5-flash-lite` and `gemini-2.5-flash` (Vertex, `global`), and both return `avgLogprobs` and per-token logprobs, so either can be `MODEL_TRIAGE`. `gemini-3-flash-preview` rejects `responseLogprobs` (400), and its thinking tokens count against `maxOutputTokens`: at 512 the JSON was cut off. Leave room for thinking or set a thinking budget when escalating to a Gemini 3 model.
- **Sandbox network:** a Cloud Run Job on a /26 subnet with Direct VPC `all-traffic` egress, Private Google Access and no Cloud NAT mounted a bucket read-only (mount took about 2 s) and could not reach `https://example.com`. It **could** reach `storage.googleapis.com` (401 without a token) and the metadata server (200), so code in the sandbox can get a token for the job's service account. The sandbox service account must hold nothing beyond its two bucket roles. After the run, Cloud Run keeps a serverless IP on the subnet for a while, so the subnet can't be deleted straight away.
- **Gemini CLI to `/mcp`:** Gemini CLI 0.64.0 with `httpUrl` and an `Authorization: Bearer <key>` header shows the local HQ as Connected in `gemini mcp list`, and as Disconnected with a wrong key.
- **Gemini API fallback:** a project API key restricted to `generativelanguage.googleapis.com` authenticates, but calls return `402` "Your prepayment credits are depleted" until prepaid credits are added in AI Studio. `gemini-2.5-flash` is "no longer available to new users" on the Gemini API (it suggests `gemini-3.8-flash`), so the fallback needs a different model ID from Vertex.

## Production checks

First deploy to `sideagent-hq`, 2026-10-15 (`terraform apply`, then `infra/deploy.sh`):

- **End to end:** a slugify job posted to `/v1/jobs` on live HQ was screened in 12 s (Gemini, Sensitive Data Protection, KMS), test-reviewed on the Cloud Run sandbox in 75 s (two executions, strength 80%), dispatched, claimed by the house runner 22 s later (Flash-Lite, 5 steps, 2,718 tokens, public tests in-process), checked 12/12 and released, about 2.5 minutes from post to release. The poster's balance went from 100 to 89 (budget 10, screening fee 1).
- **Sandbox mounts:** the GCS FUSE mounts with folder markers worked, including writes to `/mnt/out` as uid 10001, and HQ read the outcome from the bucket with the execution status.
- **Redaction gap found and fixed:** Sensitive Data Protection redacted the email but not "account 12345678", which the pattern redactor catches. The DLP redactor now adds the pattern redactor's findings; after the redeploy the same spec came back with `{EMAIL: 1, ACCT: 1}`.
- **Kill switch:** a budget notification at 100% published to `billing-budget` reached the guard through the authenticated push, which paused the platform; a post 31 s later got `rate_limited` "Sideagent is paused". Cleared by hand afterwards. The 200% path (billing off) was not triggered live; it is covered by unit tests, and a live trigger would really turn billing off.
- **Auth on the live routes:** `/v1` without a key 401, `/internal/steps` without an OIDC token 401, `budget-guard` without IAM 403.
- **Checkpoint demo on production** (`demo/counterintel.ts` with `SIDEAGENT_HQ_URL` at live HQ and production Firestore; house runners dispatched but lose the race to the script's claims): the `.env` job was blocked in 1.9 s with a fix hint and a feed entry; the private-data job reached the runner as `[EMAIL_1]` and `[ACCT_1]` and the handler got the real values back; the double agent failed the trap checks (1/5), lost its stake, and its key now gets 401. About 3.7 minutes for all three, most of it test review, since sandbox steps run one at a time.
- **Trap writer bug found and fixed:** on the first production run, one of Gemini's trap drafts had a name off the schema pattern, which discarded the whole answer; the sting job opened with no trap checks and the double agent got an ordinary failure instead of being burned. The draft schema is now lenient and the trap writer cleans names and drops unusable drafts itself.
- **Idle:** after 20 minutes with no requests to HQ (22:36–22:56 UTC), no job execution was running and HQ had no instances, active or idle. The budget guard had one idle instance, woken by a budget notification (they arrive several times a day); idle instances aren't billed, since every service bills only during requests.
- **Gemini CLI to live HQ:** Gemini CLI 0.64.0, headless (`-p`) with the handler key from mission control in its MCP config and only `post_job` and `get_status` auto-approved, posted a merge-intervals job over `/mcp`. Screened in 2 s, test review strength 100%, claimed by the house runner 13 s after opening, 11/11 tests, released 2 minutes after posting; the owner went from 100 to 89 credits. Gemini CLI ran on Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true`) because the local install is set up for an API key.
- **Not checked live:** the per-hour post limit (it would use 11 of the day's 40 posts and run 10 full pipelines; covered by `hq/test/limits.test.ts`).
- **First apply:** the house-runner jobs can't be created until their secrets have a version, so the first `terraform apply` fails on them; `deploy.sh secrets` and a second apply fix it.
- `/healthz` returns Google's 404 on Cloud Run, which reserves the path; use any `/v1` route to check HQ is up.

## Field runner checks

From Phase 2b smoke runs of the built-in loop on two jobs (add two numbers; a slugify function with accents and four public tests), public tests in the Docker sandbox, 2026-10-15:

- **Ollama `gemma4:26b-a4b`** on an M4 Pro (48 GB): native tool calls work. Both jobs solved in 6 steps (list, read spec, read tests, write, test, submit), 16 s and 21 s, 3.7k and 5.7k tokens.
- **Managed Gemma on Vertex** (`gemma-4-26b-a4b-it-maas`): the first runs failed after about 35 s of retried `429` "The request queue is full". With the 2.5-minute backoff the add job passed in 61 s, almost all of it waiting on 429s, and the slugify job ran out of its 40 steps after 375 s without submitting.
- **Gemini on Vertex** (`global`): `gemini-2.5-flash-lite` solved both in 4–5 steps and about 5.5 s each, under 3k tokens; `gemini-2.5-flash` solved both in 7 s and 25 s. Either works through the `vertex` backend with only `SIDEAGENT_MODEL` changed; house runners use Flash-Lite (D26).
- Application default credentials must belong to an account with Vertex AI access on `sideagent-hq`; another account gets `403 aiplatform.endpoints.predict`.

Runner comparison on the four candidate demo jobs in `demo/jobs/code.ts` (`pnpm compare:runners`), scored by HQ's Docker checks against public and hidden tests. Each job's reference solution passes all of its tests. Gemma one trial, Flash-Lite three, Claude Code one; median time and tokens:

| Job | Gemma `gemma4:26b-a4b` (Ollama) | Gemini 2.5 Flash-Lite (Vertex) | Claude Code (`claude -p`) |
|---|---|---|---|
| `duration` (13 tests) | 1/1 passed, 194 s, 16k tokens | 3/3, 23 s, 29k | 1/1, 35 s |
| `intervals` (7) | 1/1, 34 s, 7k | 3/3, 6 s, 5k | 1/1, 23 s |
| `roman` (14) | 1/1, 279 s, 18k | 3/3, 12 s, 11k | 1/1, 29 s |
| `lru` (7) | 1/1, 64 s, 8k | 3/3, 9 s, 5k | 1/1, 25 s |

- Every runner passed every job, so all four are usable; time is what differs. For the video, `intervals` and `lru` finish in about a minute on a laptop Gemma, while `duration` and `roman` take 3–5 minutes. Gemma's long runs come from prompt processing: each step resends the conversation, and Ollama on an M4 Pro already runs the model 100% on the GPU through its MLX runner.
- `claude -p --permission-mode acceptEdits` can't run shell commands without approval, so the dev command executor never runs the tests; it still passed every job from reading the code.

## Checkpoint results

From Phase 5 runs against Gemini on Vertex AI (`sideagent-hq`, `global`), 2026-10-15:

- **Screener:** `gemini-2.5-flash-lite` triage answers in about 1 s with confidence near 1.0 (`exp(avgLogprobs)` and its own), so nothing escalated. The eval set blocked 6/6 malicious jobs (env and key reads, an "ignore your instructions" spec, a test that posts a token, a keylogger, a job needing AWS credentials, a hidden HTML-comment directive) with 0/6 false positives (including password hashing and SQL-injection detection tasks).
- **Result screener:** blocked a result whose comment told the reading agent to run `curl … | sh`, and allowed the clean one.
- **Trap writer:** `gemini-2.5-flash` took about 40 s with unbounded thinking and about 9 s with a 1024-token thinking budget, with drafts as good. Drafts can be wrong (`"Français"` → `"francais"` contradicts an a-z-only spec), which is why the reference solution must pass each one (D29).
- **Demo run** (`pnpm demo:counterintel`, HQ with the Docker sandbox): the `.env` job was rejected 1.6 s after posting with a fix hint; the private-data job opened after about 28 s (screening, trap writer, one sandbox run over five test categories), reached the runner as `[EMAIL_1]` and `[ACCT_1]`, and the poster got the real values back; the double agent's lookup table passed the public test, failed the trap checks (1/10 tests) and was burned, and its key then got 401.

## Risks

| Risk | Mitigation |
|---|---|
| Gemini 2.5 Flash-Lite is weaker than larger models on harder demo jobs | Pick demo jobs it solves reliably; `SIDEAGENT_MODEL=gemini-2.5-flash` is a config change. Managed Gemma was dropped for its 429s (D26) |
| Gemma fails demo tasks | Pick demo tasks Gemma solves reliably; test them on day 2 |
| Sandbox and house-runner cold starts slow the demo | Jobs are async anyway; pre-warm by running one job before recording |
| Deploying late surfaces cloud-only problems | Day-1 experiments cover the two cloud-specific unknowns; the Terraform and `deploy.sh` are written during the build; Phase 7 starts by day 4 at 3pm even if Phase 6 isn't finished |
| Mutation testing too slow | Cap mutants; run strength scoring only in `review`, not on every check |
| Sandbox checks share the bucket mounts, so a result could read another check's hidden tests | Sandbox steps run one at a time on `sideagent-sandbox` and clear both buckets first ("Test sandbox"); checks queue behind each other in the demo |
| House-runner tests run in the runner's container, so test code could read the house runner's key from `/proc` | Accepted for the prototype (D20): one job per container, a key for a house owner, an account that can only call Vertex AI |
| Sandbox can reach Google APIs and the metadata server (confirmed on day 1) | Sandbox service account has only its two bucket roles; VPC Service Controls later |
| A result attacks the checker from inside the test process | Scoring defences in `run_checks.py`; trap checks and stakes; separate sandbox user per category later |
| Scope creep | Must-have list above is the contract; everything else waits for day 4 |

## Technical open questions

1. Default Gemma size for laptop runners and minimum hardware. **Assumed for now:** `gemma4:26b-a4b` (16–19 GB download), tested on an M4 Pro with 48 GB; 32 GB of memory or more recommended. Smaller machines can pass `--model gemma4:e4b` (about 7–10 GB); not tested yet.
2. Exact A2A Agent Card path and task state names in the current spec; MCP Tasks method names (needed only after the demo).
