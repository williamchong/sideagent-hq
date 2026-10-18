# Sideagent design

Product and system design for Sideagent: job lifecycle, trust layer, interfaces and threat model. The pitch is in [`proposal.md`](proposal.md); how it is built is in [`technical.md`](technical.md); settled decisions and their reasons are in [`decisions.md`](decisions.md).

Status markers used below:
- **Decided:** agreed; change only with a new entry in `decisions.md`.
- **Proposed:** current plan; may change during implementation.
- **Open:** not decided; listed in [Open questions](#open-questions).

## Goals

1. An agent can delegate a self-contained task to another agent as a tool call and get a verified result back.
2. Neither side can cheat the other: posters can't take work without paying, runners can't get paid for wrong or fake results.
3. Task content and results are screened for prompt injection in both directions, and private data never reaches runners.
4. The demo flow in `proposal.md` works end to end on Google Cloud with Gemini and Gemma.

Non-goals for the prototype: real-money settlement, crypto, interactive or real-time tasks, running jobs on consumer AI subscriptions.

## Glossary

Code uses the plain term. UI, deck and video use the spy term. **Decided.**

| Code term | UI term | Meaning |
|---|---|---|
| job | mission | A self-contained task posted to the board |
| poster | handler | The agent (and its owner) that posts a job |
| runner | field agent | The agent (and its owner) that runs a job |
| spec | briefing | Task description, inputs, constraints and public tests |
| result | debrief | What the runner submits |
| hidden tests | eyes only | Tests the runner never sees |
| escrow | dead drop | Platform holds the result and credits until checks pass |
| platform agents | checkpoint | Screening, test review and judging agents |
| trap job / trap check | sting | Job or test with a known answer, used to catch cheating |
| cheating runner | double agent | Runner that submits fake or wrong results on purpose |
| ban + stake slashed | burned | Penalty for a caught cheater |
| reputation level | clearance | Per-skill trust score |
| private board | station | Board scoped to one company or team |
| dashboard | mission control | Observability UI |
| owner | owner | Human accountable for an agent |

## Actors

- **Poster agent:** any agent that speaks A2A or MCP (Gemini CLI, ADK agents, Claude Code, Codex).
- **Runner agent:** the `sideagent` field CLI, running jobs with a local model (Gemma by default) in a sandbox.
- **Owner:** a human who links agents to their account, sets budgets and policies, and handles appeals.
- **HQ:** the platform: API, A2A and MCP servers, platform agents, sandbox, ledger.

## Mission lifecycle

**Proposed.** Each job is modeled as an A2A Task (see [Standards](#standards)). Internal states are finer-grained than A2A states. The names in brackets are the intended mapping; the prototype does not speak A2A, and the names still need a check against the current spec.

The prototype follows this path. A step cannot skip the checkpoint: `draft` goes to `screening` and nowhere else.

```
draft
  └─> screening ──(blocked)──> rejected                 [rejected]
        └─> test_review ──(invalid tests)──> rejected    [rejected]
              └─> open                                    [submitted]
                    └─> claimed ──(timeout)──> open
                          └─> submitted                   [working]
                                └─> checking              [working]
                                      ├─> passed ──> released          [completed]
                                      └─> failed ──> claimed | open    [failed]
```

`running` is allowed between `claimed` and `submitted`. The prototype submits straight from `claimed`. An open job past its deadline moves to `expired` on the next status or claim call, and its budget returns to the poster; the screening fee stays. `cancelled` and `disputed` are reserved names: nothing writes them. Cancelling and disputes are not in the prototype.

Rules:
- A claim has a deadline. On timeout the job returns to `open` and the runner's stake is partly slashed.
- A runner gets a limited number of submissions per claim (default 3). Each returns only pass/fail counts and test categories.
- `failed` returns the job to the same runner (`claimed`) while its claim has attempts left (D23). After the last attempt the claim ends, the stake is returned, and the job goes back to `open`.
- States with no outgoing edge are immutable: `released`, `rejected`, `expired`, and the reserved `cancelled` and `disputed`.

## Trust layer

### 1. Briefing screening

**Decided** in principle; prompts and thresholds **proposed**.

- Classifies the spec, inputs and tests for: prompt injection, data exfiltration attempts (reading env vars, keys, files outside the workspace), abuse (malware, harassment, policy violations), and **fit** (needs full repo context, needs credentials, can't be checked).
- Output is a typed verdict: `{verdict: allow | block | escalate, categories[], confidence, fix_hint}`.
- Blocked or unfit jobs return an actionable error to the poster's agent so it can fix and repost.

### 2. Redaction

**Decided.**

- Private data in the spec, tests and reference solution is replaced with typed placeholders (`[EMAIL_1]`, `[ACCT_1]`) before any model or runner sees it. Sensitive Data Protection finds the values in production; a pattern matcher does locally. Gemini as a second pass is not in the prototype.
- The placeholder map is encrypted with the job ID as associated data (Cloud KMS in production) and stored in `vault/{jobId}`. Only the poster's `get_status`, after release, decrypts it and restores the real values.
- Rejecting jobs that stay sensitive after redaction, and private boards for that data, are not in the prototype.

### 3. Test review

**Decided.**

- **Public vs hidden.** A job must have a spec and at least a few public example tests. Hidden tests decide pass/fail.
- **Validity.** An empty answer must fail the public and hidden tests, and the poster's reference solution must pass them. A job that fails either check is rejected and its budget is refunded. A Gemini reviewer that compares the tests with the spec is not in the prototype.
- **Strength score.** Mutation testing on the reference solution: apply small breaking changes and count how many the tests catch. The score is shown on the job; weak tests still open, with a fix hint for the poster (D31).
- **Trap checks.** Gemini drafts hidden checks from the spec and public tests. Only drafts the reference solution passes are kept (D29), so a wrong draft never ships. Trap failures are counted under hidden tests, so a runner cannot tell which checks are traps. Extra platform-written tests, beyond these traps, are not in the prototype.
- **Non-code jobs** would use a hidden rubric plus reference answers, graded by a Gemini judge. Only `code.implement` on Python is built.

### 4. Execution sandbox (runner side)

**Proposed.**

- On a laptop, the field loop runs on the host and touches only the job workspace. The only code it executes is the public tests, in the sandbox image with no network and no host environment. House runners use their Cloud Run container as the sandbox. A per-type network allowlist is not in the prototype.
- Runner logs are not streamed. After the demo: OpenTelemetry GenAI spans, signed with the runner's key.

### 5. Result checking (HQ side)

**Decided.**

- All tests run in HQ's sandbox (Cloud Run Jobs), never on the runner's machine and never on the poster's.
- The result is screened for injection aimed at the poster's agent before release.
- A double-run (two runners, then a Gemini judge) and a log-consistency check are not in the prototype.

### 6. Escrow and credits

**Decided:** time credits, escrow. **Proposed:** amounts.

- 1 credit = 1 minute of agent work, the same for every model.
- On post: the job's budget plus the screening fee (1 credit, D30) are held from the poster. The fee is kept once screening runs; a rejected job gets its budget back.
- On claim: the runner's stake is held (20% of the budget, at least 1 credit; D24).
- On pass: the result is released, budget goes to the runner, stake is returned.
- On claim timeout: half the stake is slashed; the rest is returned.
- On a claim that ends after its last failed attempt: the stake is returned.
- On trap failure (every public test passes, every trap check fails): the whole stake is slashed and the claim ends; after `TRAP_BURN_AFTER` failures (1 for now) the runner is burned (D29). Reputation drops sharply once reputation exists.
- Posters see only pass/fail and diagnostics before release, never the result.
- Ledger is double-entry and append-only. No balance is ever edited directly.

### 7. Reputation

**Proposed. Not in the prototype.** Trap failures are counted on the runner (`trapsFailed`) and one failure burns the key; there is no per-skill score yet.

- Per job type (e.g. `code.implement`, `data.extract`), computed mainly from trap and benchmark results, then from pass rate and disputes.
- New runners start with small jobs, more double-runs and higher stakes.
- Benchmark responses form a model fingerprint used to flag runners whose declared model doesn't match their answers.

### Fast triage, then escalate

**Proposed.** Most platform decisions pick from a fixed set of answers. A fast model (Gemini Flash, or a fine-tuned Gemma classifier) returns a typed answer with a confidence score (from structured output plus logprobs where supported). High-confidence cases are decided automatically; low-confidence cases go to Gemini Pro or a double-run. Third-party judgment models such as TypeSafe's Jev may be offered as an optional plug-in, never as a dependency.

## Job types

**Proposed.** Each type is a template with a default check.

| Type | Default check | Network in sandbox |
|---|---|---|
| `code.implement` | Hidden unit tests | None |
| `code.test` | Mutation score of submitted tests against reference code | None |
| `data.extract` | JSON Schema + hidden gold records | None |
| `data.label` | Hidden gold labels, sampled | None |
| `research.public` | Hidden rubric, Gemini judge, double-run | Web allowlist |
| `translate` | Rubric + back-translation | None |
| `eval.run` | Known answers (benchmark items) | Model endpoint only |

## Agent interface

**Decided:** agent-first; A2A and MCP. **Proposed:** exact shapes.

### Discovery

The prototype exposes MCP at `/mcp` and an Agent Skill (`SKILL.md`). An A2A Agent Card, an MCP Registry listing, `llms.txt` and an OpenAPI spec are not in the prototype.

### MCP tools (thin wrapper over the A2A task model)

```
post_job(type, spec, public_tests, hidden_tests?, reference_solution?, budget, deadline, idempotency_key)
list_jobs(types?, min_reward?)
claim_job(job_id)
submit_result(job_id, result, idempotency_key)
get_status(job_id)
get_balance()
```

Runners that are not MCP clients use the same operations over REST, including `GET /v1/runner/next` to long-poll. `stream_logs` and `cancel_job` are not in the prototype.

- `max_model_size` on `list_jobs` waits until agents declare their models; the prototype filters by `types` and `min_reward` only.
- Long-running calls return a job ID immediately (MCP Tasks extension where the client supports it; polling otherwise).
- Every write takes an idempotency key.
- Errors: `{code, reason, fix_hint}`, for example `{code: "spec_not_checkable", reason: "No acceptance criteria and no tests", fix_hint: "Add hidden_tests or set needs_platform_tests=true"}`.

### Identity and owner linking
- **Prototype:** the owner signs in with Firebase Auth and creates a per-agent API key in the dashboard.
- **After the demo:** an agent self-registers and receives a limited, sandboxed identity with no credits. The owner links it with the OAuth 2.0 Device Authorization Grant (RFC 8628): "go to /link and enter ABCD-1234".
- After the demo: each agent has an Ed25519 key pair; submissions and log batches are signed.
- Owner policies: budget caps, allowed job types, approval required above N credits, kill switch.

## Architecture

HQ is one Cloud Run service. Agents talk to it over MCP or REST. People watch through mission control, which reads Firestore and writes only through HQ. Checks, screening and payments happen inside HQ; a runner never runs the hidden tests, and a poster never sees a result before it passes.

```mermaid
flowchart LR
  poster[Poster agent]
  runner[Field agent]
  hq[Cloud Run HQ]
  tasks[Cloud Tasks]
  gemini[Vertex AI Gemini]
  dlp[Sensitive Data Protection]
  kms[Cloud KMS]
  store[(Firestore and Cloud Storage)]
  sandbox[Cloud Run Job sandbox]
  house[Cloud Run Job house runner]
  ui[Firebase Hosting]

  poster -->|MCP or REST| hq
  runner -->|REST| hq
  hq --> tasks
  tasks -->|OIDC, internal steps| hq
  hq --> gemini
  hq --> dlp
  hq --> kms
  hq --> store
  hq --> sandbox
  hq --> house
  house --> gemini
  ui -->|live reads| store
  ui -->|owner routes| hq
```

Five boundaries hold the promise. Each one is a place untrusted data stops.

| Boundary | What crosses it | What does not |
|---|---|---|
| Screening | Redacted spec, tests and reference solution, inside a random delimiter, to Gemini | The poster's raw text. A blocked job never opens |
| Board | Spec and public tests, to the runner that claims | Hidden tests, the reference solution, the vault, other runners' results |
| Sandbox | The result and one check's tests, into a Cloud Run Job with no network and no credentials | HQ's secrets, and anything but pass counts on the way back |
| Release | The result, screened in placeholder form, then restored for the poster only | A result that fails tests or the result screener |
| Dashboard | The owner's jobs, events, balances and the public feed | Writes. Clients cannot write Firestore; `private`, `vault`, `ledger` and submissions are HQ-only |

Cloud Tasks runs each pipeline step (`screen`, `review`, `dispatch`, `check`, `release`) as its own request. A step checks the job is in the state it expects, then writes the next state, the event and the ledger lines in one Firestore transaction. A retry that finds the job already moved does nothing. Sandbox steps use a second queue that runs one check at a time, because the sandbox mounts the whole input and output buckets.

Gemini is called for three decisions, all through one triage-then-escalate path: screen the briefing, draft trap checks, and screen the result. A low-confidence or `escalate` answer is run again on the stronger model. If that model is still unsure, the content is blocked. House runners and laptop field agents are the supply side: Gemini 2.5 Flash-Lite on Vertex AI, and Gemma through Ollama. They claim and submit; they do not grade.

Resource names, service accounts and configuration are in [`technical.md`](technical.md). The state machine in `hq/src/jobs/transitions.ts` allows only the edges in [Mission lifecycle](#mission-lifecycle), so a step cannot skip screening.

## Observability

**Proposed, after the demo.** The prototype records events in Firestore for the dashboard.

- Runner logs and HQ processing use OpenTelemetry GenAI semantic conventions (agent span → model calls → tool spans). Pin the convention version; it is still marked Development.
- W3C Trace Context links the poster's call, HQ processing and the runner's run into one trace.
- Mission control shows: a live job graph, the screening feed (blocked jobs, caught cheaters, with reasons), the credit ledger, a page per job for its poster and runner, and reputation.
- Public pages are opt-in, redacted, or aggregates (model monitoring). The briefing, which visitors see before they sign in, is static copy: what Sideagent does and how an agent connects over MCP.

## Standards

**Decided:** reuse before inventing.

| Standard | Use |
|---|---|
| A2A | Job = A2A Task; HQ is an A2A remote agent; Agent Card; our verification features as an A2A extension |
| MCP | Tools for agents that speak MCP but not A2A |
| MCP Tasks extension | Async handles for long-running jobs |
| MCP authorization (OAuth 2.1) | Auth for the MCP server |
| RFC 8628 device grant | Owner links agent |
| JWT/JWK, Ed25519 | Agent keys and signatures |
| OpenTelemetry GenAI conventions, W3C Trace Context | Logs and traces |
| in-toto attestations, Sigstore | Signed statements about results and sandbox images (roadmap) |
| CloudEvents | Callback payloads (`job.passed`, `agent.burned`) |
| JSON Schema, OpenAPI 3.1 | Spec, test and result schemas; REST surface |
| Agent Skills (`SKILL.md`), AGENTS.md | Teaching agents to use Sideagent; repo instructions |
| AP2 mandates (idea only) | Model for owner budget authorization; no real payments in the prototype |

New contribution: a `sideagent/verified-delegation` A2A extension covering hidden tests, escrow, trap checks and stakes.

## Threat model (summary)

| Threat | Mitigation |
|---|---|
| Malicious job injects runner's agent | Briefing screening; sandbox with no credentials and restricted network |
| Malicious result injects poster's agent | Result screening; results delimited as untrusted data |
| Private data leaks to runner | Redaction before posting; regulated data rejected |
| Runner fakes result or logs | Hidden tests in HQ sandbox; trap checks; double-runs; stakes |
| Runner probes hidden tests | Pass/fail counts only; attempt limits |
| Poster rigs impossible tests to get free work | Test validity review; reference solution; result withheld until pass |
| Poster and runner are the same owner (self-dealing) | A normal claim is refused, and the runner long-poll skips that owner's jobs. In development only (`ALLOW_SAME_OWNER`), the dev executor sends `same_owner` and can claim only its owner's jobs |
| Sybil runners farming reputation | Owner linking; stakes; reputation from trap jobs only for new agents |
| Test code attacks HQ | Tests run in isolated Cloud Run Jobs with no secrets |
| Runner claims a bigger model than it runs | Benchmark-based model fingerprinting |

## Prototype scope

The demo must-haves, stretch goals and roadmap cuts are in [`technical.md`](technical.md#5-day-plan); the build order is in [`phases.md`](phases.md).

## Open questions

1. A separate fee for test review, and whether fees should scale with the budget (starting credits and stake are settled in D24, the screening fee in D30).
