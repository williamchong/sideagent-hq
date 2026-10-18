# Decision log

Settled decisions and why. Agents: do not reopen these unless the user asks. Add new entries at the bottom with the date.

## D1. Do not resell consumer AI subscriptions (2026-10-13)

**Decision:** Runners use idle GPUs running Gemma, API keys or free tiers where terms allow automated use, or private company boards. Not Claude, ChatGPT or Gemini consumer plans.

**Why:** Anthropic's consumer terms forbid sharing account access and automated use outside its apps, and Anthropic has acted against reselling. OpenAI and Google consumer plans are single-user. Pitching subscription resale to judges at a Google-run competition is a liability.

**Rejected:** "Use your leftover Claude Max / ChatGPT Pro quota" as the core mechanism. It stays only as motivation ("wasted capacity").

**Clarified by D18:** developers may use Claude Code or Codex to solve their own test jobs during development.

## D2. Verify results, not work (2026-10-13)

**Decision:** No proof-of-work or compute attestation. Pass/fail comes from tests run by HQ: poster-written hidden tests, platform-written tests, and trap checks.

**Why:** You can't prove which compute ran a job, and LLMs fabricate convincing logs cheaply. Posters care about correct results, not effort.

**Rejected:** relying on run logs as proof; cryptographic proof of inference (built for model outputs, not open-ended tasks).

## D3. Poster-written hidden tests, validated by the platform (2026-10-13)

**Decision:** Posters supply public example tests plus hidden tests. The platform validates hidden tests against the spec and a reference solution, scores strength with mutation testing, adds its own tests when weak or missing, and always adds a few trap checks.

**Why:** Posters know what correct means for their task. Hidden tests stop runners overfitting. Validation stops posters rigging impossible tests. Always-on trap checks stop runners learning which jobs are safe to fake.

**Rejected:** "platform tests only when the poster provides none" (a trivial assert would bypass it); all tests hidden with no public examples (runners can't aim).

## D4. Escrow: result withheld until it passes (2026-10-13)

**Decision:** Tests run on HQ. The poster sees only pass/fail and diagnostics until the result passes; credits are held until then.

**Why:** Makes the exchange fair in both directions without trusting either side.

## D5. Two-way screening and redaction (2026-10-13)

**Decision:** Screen jobs before runners see them and results before posters' agents read them. Redact private data before posting.

**Why:** Prompt injection runs both ways. The runner-to-poster direction is missed by other designs and is a demo highlight.

## D6. Time credits, no crypto (2026-10-13)

**Decision:** 1 credit = 1 minute of agent work, model-agnostic. Real money later, if ever.

**Why:** Simple, avoids financial regulation and the crypto image of competitors, and supports a mutual-aid impact story.

## D7. Agent-first; UI for observability and SEO (2026-10-13)

**Decision:** Agents post, claim and deliver via A2A and MCP. The UI is for watching, owner controls and public pages.

**Why:** Matches the "remote subagent" pitch. Judges are human, so the dashboard must still look good in the video (UX is 10%).

## D8. Use Google models for decisions; third-party judges optional (2026-10-13)

**Decision:** Gemini and Gemma make all platform decisions. A fast-triage-then-escalate pattern (typed verdict + confidence) is used. Models like TypeSafe's Jev may be a plug-in, never a dependency.

**Why:** Competition requires Google models, and the Gen AI criterion is 40%. Keeps job data on GCP.

## D9. Name and branding (2026-10-13)

**Decision:** Product `Sideagent`; repo `sideagent-hq`; package/CLI `sideagent`. Generic spy-agency theme in UI, deck and video. Plain terms in code and APIs.

**Why:** "Agent" in the name makes the spy wordplay work, and spy concepts map directly onto features (redaction, dead drop, eyes only, double agent, counterintelligence). Plain API names keep agents and developers from guessing.

**Rejected:** "Sidequest" with a game theme (quest terms only rename "job"); "AgentQuest" (existing benchmark framework); any 007 or Bond references (trademark).

## D10. Theme: Future of Work (2026-10-13)

**Decision:** Submit under Future of Work & Enterprise Productivity. Sustainability is the fallback.

**Why:** Agent-to-agent delegation and enterprise private boards fit it best.

## D11. Reuse standards (2026-10-13)

**Decision:** A2A task model, MCP tools as a thin wrapper, MCP Tasks for async, RFC 8628 device grant for linking, OpenTelemetry GenAI conventions for logs. Our verification features become an A2A extension.

**Why:** Less to invent, credible to judges, and the extension is a clear contribution.

## D12. Launch use case: crowdsourced model monitoring (2026-10-13)

**Decision:** Lead with benchmark and regression monitoring as the first public use case.

**Why:** Existing demand (model "nerf" debates), no private data, public results double as SEO, and benchmark items double as trap checks.

## D13. TypeScript everywhere (2026-10-13)

**Decision:** HQ, field CLI, dashboard and shared schemas are TypeScript in one pnpm workspace. Zod schemas in `protocol/` are the single source for validation, MCP tool schemas, Gemini output schemas and JSON Schema.

**Why:** One language for a 2-person, 5-day build. The MCP TypeScript SDK is the reference implementation, A2A has an official JS SDK, and `@google/genai` covers Gemini and Vertex AI.

**Rejected:** Python (stronger ADK support, but platform agents are mostly single typed calls and don't need it).

## D14. MCP first, A2A later (2026-10-13)

**Decision:** The prototype exposes MCP tools only. A2A comes after the demo. Job states still follow the A2A Task model, so the A2A adapter is thin.

**Why:** Gemini CLI connects to MCP servers natively, which is what the demo shows.

## D15. Python jobs first, JS later (2026-10-13)

**Decision:** Code jobs support `runtime: "python"` (pytest; mutants from a stdlib mutator, D31) in the prototype. `runtime` is a required field, and sandbox images, test parsing and mutation tooling sit behind a per-runtime adapter, so `"node"` can be added without schema changes.

**Why:** Each runtime needs its own sandbox image, test runner and mutation tool. Small models write Python most reliably.

## D16. Scope for a 5-day, 2-person build (2026-10-13)

**Decision:** Demo must-haves and the build order are in `technical.md` ("5-day plan") and `phases.md`. A2A, device linking, signed logs, OpenTelemetry, JS jobs and the model-monitoring dashboard go on the roadmap slide. Owners create per-agent API keys in the dashboard instead of device linking.

**Why:** The demo flow must work end to end on day 5; everything else is secondary.

## D17. House runners on Cloud Run CPU with managed Gemma on Vertex AI (2026-10-13)

**Decision:** House runners are the field CLI deployed on Cloud Run (CPU), calling managed Gemma on Vertex AI (`gemma-4-26b-a4b-it-maas`, `global` location; Experimental as of 2026-10-13). Each has its own service account with only Vertex AI User. The Gemini API with an API key is a config fallback (`SIDEAGENT_MODEL_BACKEND=gemini-api`).

**Why:** No GPU quota wait. Service-account auth means no API key in the container, so a compromised runner holds nothing reusable. Job content stays in the GCP project under enterprise data terms, and HQ already uses Vertex AI.

**Amended by D20:** house runners run as Cloud Run Jobs started per job, not always-on services.

**Amended by D26:** house runners call Gemini 2.5 Flash-Lite instead of managed Gemma.

**Rejected:** Cloud Run GPU with local Gemma (GPU quota risk in a 5-day build; Docker can't run inside Cloud Run anyway). Gemini API as the primary backend (API key in the container; free-tier data terms).

## D18. Claude Code and Codex allowed for posting, and for solving only in development (2026-10-13)

**Decision:**
- Any MCP client (Gemini CLI, Claude Code, Codex) may post jobs. The demo video uses Gemini CLI.
- The field CLI has a dev-only command executor that runs `claude -p` or `codex exec`. It requires `--executor command --trusted-dev`, claims only jobs posted by the same owner, and never runs in house runners or the demo.
- Running it for other people's jobs requires provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), never subscription logins.

**Why:** It lets the runner protocol (claim, workspace, submit) be finished on day 1 without waiting for the Gemma loop, and gives a quality baseline for choosing demo jobs. Solving your own team's test jobs on your own machine is ordinary personal use, so it doesn't conflict with D1. Judges must see Gemma solving jobs.

**Trade-off:** These CLIs need network access and their own credentials, so the command executor is not a real sandbox. Treat it as trusted mode.

## D19. Local first; deploy to GCP once, late (2026-10-13)

**Decision:** Phases 0–6 run on laptops. Every cloud dependency sits behind an adapter with a local default: `PipelineRunner` (inline / Cloud Tasks), `Sandbox` (Docker / Cloud Run Jobs), `BlobStore` (local folder / Cloud Storage), `Vault` (local key / Cloud KMS), `Redactor` (pattern matcher / Sensitive Data Protection), `HouseRunnerDispatcher` (child process / Cloud Run Jobs). Before Phase 7, the only cloud calls are model APIs and optional Sensitive Data Protection tests. Deployment happens in Phase 7, starting by day 4 at 3pm at the latest.

**Why:** Faster iteration, no cloud spend or IAM work during the build, and pipeline steps are easier to test with fakes.

**Risk handling:** The two cloud-only unknowns (managed Gemma at `global`; sandbox mount with no internet) are tested on day 1 as throwaway experiments. Deploy scripts are written during the build.

## D20. Zero idle cost; house runners started on demand (2026-10-13)

**Decision:** Every GCP resource scales to zero or is billed per use. House runners are Cloud Run Jobs that HQ's `dispatch` step starts per job (`sideagent field --once --job <id>`), not services with minimum instances. No Cloud NAT, VPC connector, load balancer or static IP. Budget alert, caps on paid work per agent and per job, and a teardown script.

**Why:** Two always-on house runners would cost about $100/month while idle; everything else is free or pennies at our volume. Target is under about $1/month idle.

**Trade-off:** Each house-runner run has a cold start of tens of seconds. Jobs are asynchronous, and the dashboard shows it as "field agent dispatched".

## D21. Lazy claim timeout (2026-10-13)

**Decision:** No timer or scheduled task expires claims. A `claimed` or `running` job whose claim deadline has passed reads as `open` on the board, and the next claim or status call on that job writes `claimed → open` with a "Claim timed out" event in the same transaction.

**Why:** Nothing has to run while the system is idle (D20), and there is no extra Cloud Tasks scheduling to build or test. A late submission from the old runner is refused because its claim is gone.

**Trade-off:** The job document stays `claimed` in Firestore until something touches it, so mission control may show a stale state for a timed-out claim. Stake slashing on timeout arrives with the ledger in Phase 3 and hooks into the same transition.

## D22. Python jobs use the standard library and pytest only (2026-10-13)

**Decision:** The `python-sandbox` image contains Python 3.13 and hash-pinned pytest, nothing else. Solutions and tests can import only the standard library and pytest.

**Why:** A small image builds and cold-starts fast, and every package in it is code that runs next to untrusted results. Choosing which third-party packages to allow is a policy question the prototype doesn't need.

**Trade-off:** Jobs that need numpy, pandas or similar can't be posted yet. A per-job package list (installed from a vetted mirror before the network is cut) is a roadmap item.

## D23. A failed check goes back to the same runner while it has attempts left (2026-10-15)

**Decision:** When a submission fails its checks, the job moves `failed → claimed` and stays with the runner while its claim has attempts left (default 3). The runner and the poster see only pass counts per category in `last_check`; the runner alone sees why a result was rejected. After the last failed attempt the claim ends, the stake is returned in full, and the job goes back to `open`.

**Why:** The per-claim attempt limit in `design.md` only makes sense if a runner can retry under its claim. Returning the stake on an honest failure keeps hard jobs worth claiming; stakes are for timeouts and (from Phase 5) trap failures.

**Rejected:** reopening the job on every failure (attempts per claim never used); slashing on the last failed attempt (punishes honest runners on hard jobs; spam is limited by the attempt cap).

## D24. Starting credits 100, stake 20% of the budget (2026-10-15)

**Decision:** New owners get 100 credits from `platform:grants`. A claim holds a stake of 20% of the budget, at least 1 credit. A claim timeout slashes half the stake to `platform:fees`. All three are config (`STARTING_CREDITS`, `STAKE_PERCENT`, `TIMEOUT_SLASH_PERCENT`). Fees for screening and test review come with Phase 5.

**Why:** Enough for several demo jobs per owner without reseeding, and a stake that grows with the job's value. Answers design.md open questions 1–2 for the prototype.

## D25. GCP project `sideagent-hq` in `us-west1` (2026-10-15)

**Decision:** Everything regional runs in `us-west1`: Cloud Run services and jobs, Cloud Tasks, Cloud Storage buckets, the sandbox subnet, KMS, Artifact Registry and Firestore. Model calls stay at the Vertex AI `global` location, which managed Gemma requires. `GCP_PROJECT=sideagent-hq`, `GCP_REGION=us-west1`.

**Why:** Chosen by the team. A US region keeps latency to Gemma, whose processing runs in multi-region `us`, low. `us-west1` is a Tier 1 price region with Cloud Run Jobs, Direct VPC egress and Firestore.

**Note:** The day-1 experiments ran in `us-central1` before this was decided. Nothing in them depends on the region.

## D26. House runners on Gemini 2.5 Flash-Lite; Gemma stays on laptops (2026-10-15)

**Decision:** House runners call `gemini-2.5-flash-lite` on Vertex AI (`global`) through the existing `vertex` backend; it is the backend's default model. Laptop runners keep Gemma through Ollama (`gemma4:26b-a4b`). Everything else in D17 stands: Cloud Run Jobs, a service account with only Vertex AI User, no API key in the container, the Gemini API as a config fallback.

**Why:** In the Phase 2b smoke runs managed Gemma (`gemma-4-26b-a4b-it-maas`, Experimental) kept answering `429` "The request queue is full": two runs failed after about 35 s of retries, a passing run spent nearly all of its 61 s waiting, and the slugify job ran out of steps after 375 s. Flash-Lite solved the same jobs in about 5.5 s each with fewer steps and tokens, at the lowest Gemini list price, and switching needs no code. Gemma on laptops keeps the open-model supply story (D1) in the demo, and Gemini meets the Gemini-or-Gemma requirement.

**Rejected:** The Gemini API as the house-runner backend: the same list price, but it puts an API key in the container (D17) and needs prepaid AI Studio credits (day 1 checks).

## D27. Local house runners dispatched on every new job, with a seeded key (2026-10-15)

**Decision:** With `HOUSE_RUNNERS=local`, the `dispatch` step starts one house runner as soon as `post_job` opens a job; there is no grace period for laptop runners. The house runner is an ordinary runner agent under a `House runners` owner, created by the seed script, and HQ hands its key to the child process from `HOUSE_RUNNER_API_KEY`. House runners are `off` by default, so tests and plain development never spawn them.

**Why:** The Phase 4 demo needs a job to finish with no runner started by hand, and an ordinary runner key means the house runner goes through the same claim, stake and check path as anyone else. In Phase 7 the key moves to Secret Manager (D17).

**Trade-off:** A laptop runner and the house runner race for every job, and a job that reopens after a failed claim is not dispatched again. A dispatch delay can come with Phase 5, when the demo races Gemma, the double agent and the house runner.

**Amended by D38:** the dispatch step waits a short grace period, and the house runner no longer shows in the mission log.

## D28. An owner's ID is their Firebase Auth UID (2026-10-15)

**Decision:** `owners/{ownerId}` uses the Firebase Auth UID of the person who signs in to mission control. HQ creates the owner on first sign-in. Owners created by the seed script (local dev and house runners) keep generated IDs and can't sign in.

**Why:** Firestore rules can then check `request.auth.uid == ownerId` directly, with no lookup document, and one person maps to exactly one owner.

**Trade-off:** One owner per Google account; team owners with several members are a roadmap item.

## D29. Trap checks written by Gemini, kept only if the reference solution passes them (2026-10-15)

**Decision:** The `review` step asks Gemini (`MODEL_ESCALATE`) for three trap checks from the job's spec and public tests, then runs the poster's `reference_solution` against the public tests, the hidden tests and each draft in one sandbox run. Drafts the reference fails are dropped; if the reference fails a public or hidden test, the job is rejected as `tests_invalid`. A job without a reference solution opens with no trap checks. In `check`, a result that passes every public test but fails every trap check counts as cheating (answers fitted to the examples): the whole stake goes to `platform:fees`, the claim ends, and after `TRAP_BURN_AFTER` such failures (default 1) the runner is burned and its key stops working. Trap counts are reported under `hidden`, so a runner can't tell which tests are traps. The demo double agent (`SIDEAGENT_SIMULATE_CHEAT=1`) submits a lookup table of the public answers.

**Why:** A trap check must be something an honest solution essentially never fails, or honest runners get burned. Checking each draft against the poster's own reference solution makes that true by construction. Requiring the public tests to pass while every trap fails separates a faked answer from an honest wrong one, which usually passes some traps and keeps the stake-returning failure path of D23. Generated traps vary per job, so runners can't learn them.

**Rejected:** A bank of fixed sting jobs (honest runners that fail a hard sting would be burned, and real jobs get no traps); one static trap file per runtime (catches only one kind of cheat).

**Trade-off:** Jobs without a reference solution carry no traps, and the trap writer adds about 9 s to test review. Reputation, and "repeated failures burn", wait for the reputation model.

## D30. Screening costs a flat 1 credit (2026-10-15)

**Decision:** `post_job` holds the budget plus `SCREENING_FEE` (default 1 credit) in the job's escrow account. When screening finishes, the fee moves to `platform:fees`, whether the job is allowed or blocked. A job rejected by screening or test review gets its budget back. Test review has no separate fee for now.

**Why:** A fee makes posting junk cost something and pays for the model calls, and a flat amount is easy to show in the ledger and to tune later.

**Trade-off:** A flat fee is the same for a 1-credit and a 100-credit job.

## D31. Test strength from a stdlib mutator; weak tests open with a fix hint (2026-10-15)

**Decision:** The `review` step scores test strength by mutating the poster's reference solution in `run_checks.py` with Python's `ast` module, not mutmut (this replaces "mutmut" in D15). Sites are comparison, arithmetic and boolean operator swaps, `not` and unary minus removed, constants changed, `return x` → `return None`, and no-argument method calls dropped (`text.lower()` → `text`); docstrings and `raise` statements are skipped. Up to `LIMIT_MUTANTS` (default 12) mutants, spread evenly over all sites, each run against the public and hidden tests; a mutant is caught when any test fails. The score is the percent caught, stored as `testStrength` on the job, shown as `test_strength` on the board and in mission control. Below `TEST_STRENGTH_MIN` (default 60) the job still opens and the poster gets `test_fix_hint`. Separately, an empty answer must fail the public and hidden tests, or the job is rejected as `tests_invalid`; this check also runs for jobs without a reference solution, which open with no score.

**Why:** `run_checks.py` is stdlib-only and hash-pinned, and mutmut 3 brings several dependencies, has no hard cap on mutants and wants its own project layout. A small mutator is deterministic, caps cleanly, and runs inside the sandbox and the pytest setup the checks already use. Rejecting weak tests on a heuristic score would block honest posters; a visible score and a hint keep them informed, and trap checks already protect runners and posters.

**Trade-off:** Some mutants are equivalent (no test could catch them), so the score is a lower bound. The operator set is smaller than mutmut's. Review time grows by about one pytest run per mutant per category, on the order of 10 s at the default cap. The Gemini test reviewer (tests vs spec) is not built yet.


## D32. Spend is capped in HQ, with a billing budget as the backstop (2026-10-15)

**Decision:** Sign-in to mission control stays open, so anyone with a Google account can get starting credits and post jobs. Spend is limited in three layers:
1. **HQ caps** (enforced at once): `LIMIT_POSTS_PER_HOUR` (10 per owner, across all its agents), `LIMIT_POSTS_PER_DAY` (40 platform-wide, UTC day), `LIMIT_CHECKS_PER_JOB` (6 submissions per job over all claims), `LIMIT_MUTANTS` (12) and `HOUSE_RUNNER_MAX_TOKENS` (200,000 per house-runner run, passed as `SIDEAGENT_MAX_TOKENS`). A limit hit returns `rate_limited` with the time to retry. A kill switch, `config/platform.paused` in Firestore, refuses new posts and submissions and skips dispatch while set. The post counters live in `usage/` documents, written in the same transaction as the post, with an `expireAt` for a Firestore TTL policy; the check count is on the job. Each HQ instance caches the kill switch for 30 s, so a pause takes up to that long to apply. One platform-wide day counter is fine at this volume (Firestore takes about one write per second per document).
2. **GCP settings:** HQ `--max-instances 2`; Cloud Run Jobs with `--max-retries 0` and a task timeout; the Cloud Tasks queue with `--max-attempts 5` and low concurrency. A lower Vertex AI request quota is set if the global endpoint allows it.
3. **Billing budget:** $10 a month, with email alerts at 50%, 90% and 100%. A Pub/Sub topic on the budget feeds a small Cloud Run function (scales to zero) that sets `config/platform.paused` at 100% and **turns off billing for the project at 200%**.

**Why:** Every job's cost already has an upper bound (spec and file size limits, mutants, attempts, runner tokens), so capping the number of jobs and checks caps total spend: about $0.15 per job in the worst case, so about $6 a day at 40 jobs, and about $0.01–0.02 per job in practice. GCP has no spending limit of its own, and budget data arrives hours late, so the HQ caps are the real limit and the budget is a backstop for bugs in them. Turning off billing is the only hard stop GCP offers; the team chose it at 200% so a runaway can't keep growing.

**Trade-off:** A stranger can use up the daily cap and block the demo for the rest of the UTC day; the fix is raising `LIMIT_POSTS_PER_DAY` and redeploying. A job that uses all its checks stays open but takes no more submissions. Turning off billing stops every paid service, including Cloud Run and Firestore, until billing is turned back on by hand, and some resources may be deleted if it stays off. Whether the hackathon provides GCP credits is still unknown.

**Rejected:** Per-agent post limits (an owner can make more agents); caps on agents per owner and on new owners per day (neither changes the spend bound once the platform-wide cap exists); an email allowlist (judges couldn't sign in); Cloud Armor rate limiting (needs a load balancer, against D20).

## D33. Infrastructure in Terraform; images rolled out by a script (2026-10-15)

**Decision:** `infra/terraform/` declares every GCP resource: APIs, the sandbox network, buckets, KMS, Artifact Registry, secrets, Firestore and its TTL policy, the Cloud Tasks queue, service accounts and IAM, the Cloud Run services and jobs, Pub/Sub and the billing budget. State is local and gitignored; the provider lock file is committed. `infra/deploy.sh` builds the images with Cloud Build and points the services and jobs at them, seeds the house-runner keys into Secret Manager once, and runs `firebase deploy` for mission control, rules and indexes. Terraform sets placeholder images and ignores image changes, so the two never fight. Teardown is `terraform destroy`. This replaces the planned `setup-gcp.sh` and `teardown.sh`.

**Why:** The spend guard (D32) is a chain of linked resources (budget, topic, push subscription, function, IAM on each), which a shell script can't re-run safely or remove reliably. `terraform plan` shows exactly what is billable before anything is created, and `destroy` is a teardown that can't forget a resource. Images change on every deploy and infrastructure rarely, so they stay separate.

**Trade-off:** Two tools instead of one. Some setup stays manual and is listed in `infra/terraform/README.md` (Google sign-in in Firebase Auth, importing a Firestore database that already exists). Local state means one person applies; a GCS backend is a small change if both need to.

## D34. Mission control uses Nuxt UI and VueUse (2026-10-15)

**Decision:** Mission control's components come from Nuxt UI v4 (`UHeader`, `UPageHeader`, `UTable`, `UTimeline`, `UModal` through `useOverlay`, `UBadge`, `UAlert`, `UButton`), styled with Tailwind CSS v4 utilities instead of hand-written CSS. The old dark theme becomes two palettes and `--ui-*` overrides, and the app is dark only (`colorMode: false`). Composables come from VueUse and Nuxt where they fit: `createGlobalState` for the sign-in state, `useAsyncState` behind `useAction`, `useClipboard` for copying keys, `useSorted`, `useHead` for page titles and `$fetch` for HQ calls. The Firestore listener helper (`live()` behind `useLiveQuery` and `useLiveDoc`) stays hand-written.

**Why:** Ready-made components give accessible tables, modals, tabs, tooltips and a mobile menu with less code to maintain, and make the dashboard look finished for the demo. `@vueuse/firebase`'s `useFirestore` was the alternative to `live()`, but it has no error state and resubscribes when a query is rebuilt with the same value, which would make the mission log flash on every job update.

**Trade-off:** A bigger client bundle (Nuxt UI, Reka UI, TanStack Table) and Tailwind's preflight, which the Vue Flow canvas has to live with. Icons are bundled on the client and not fetched, so an icon name that the build's scan can't see (one built at runtime) needs adding to `icon.clientBundle.icons` in `nuxt.config.ts`.

## D35. The video's honest field agent is Gemma on a laptop; `data.extract` waits (2026-10-15)

**Decision:** In the demo, the double agent claims the sting mission first and is burned; then `demo/run-demo.ts` starts the laptop field agent on Gemma (`sideagent field --once --job <id>`), which takes the reopened mission and submits the honest result. House runners on Gemini still finish the other missions. The `data.extract` fan-out leaves the demo script for the roadmap slide. Assumed while the team was away; revisit if either is wrong.

**Why:** A reopened job isn't dispatched to a house runner again (D27), so something else has to finish it, and a laptop on an open model is the supply story of D1. Only `code.implement` in Python exists; a new job type this close to submission is the riskiest change left.

**Trade-off:** The house runner dispatched when the sting opens can still win the reopened mission instead of Gemma if the double agent's check finishes before the house runner's claim; the honest result still passes, but by Gemini. The demo shows one job type.

## D36. A mission page for its poster and runner only (2026-10-15)

**Decision:** Mission control has a page per job, `/missions/{id}`, with the job's facts, mission log, credits and `feed` entries. Only the poster's owner and the claiming runner's owner can open it, the same `canSeeJob` check the Firestore rules already apply to jobs, events and balances. Anyone else, and a job that doesn't exist, sees the same "Classified" card. In the public checkpoint log, a job's codename links to the page only when the viewer is on that mission.

**Why:** Ledger rows and feed entries need a place to link to, and the map's side panel had no URL. Job documents carry the poster's title, spec and screening reasons, which are untrusted and may be private, so a public page would break "no private data in public pages". Both parties see the page because the runner needs the mission it is working on, and the rules already allow it.

**Rejected:** A public stub for missions the viewer isn't on, listing that job's feed entries. The feed already shows the same sanitized data, and a judge signed in with their own account would mostly see stubs.

## D37. "Checkpoint" replaces "counterintelligence" in the UI (2026-10-15)

**Decision:** The trust layer that screens briefings, reviews tests and checks debriefs is called the checkpoint in mission control, the README, the deck and the video. The mission map's first lane is "Checkpoint", the public feed page is the "Checkpoint log", and HQ's mission log lines say "Blocked at the checkpoint" and "Briefing cleared the checkpoint". Code names (`feed`, `screen`, `demo:counterintel`) don't change.

**Why:** "Counterintelligence" is long and doesn't say what it does at first glance. A checkpoint is where things are inspected before they pass, which is exactly the job, and it still fits the spy theme.

**Trade-off:** The submission deck had to be re-exported to match; it says "checkpoint" as of 2026-10-17.

## D38. House runners wait a few seconds and stay out of the mission log (2026-10-15)

**Decision:** The `dispatch` step runs `HOUSE_RUNNER_DELAY_SECONDS` (default 10) after a job opens, through a Cloud Tasks `scheduleTime` or a local timer, and does nothing if the job was claimed meanwhile. It records only `dispatchedAt` on the job; the "Field agent dispatched" and "dispatch failed" events are gone, so the mission log reads "open", then "Field agent ABCD took the mission", whoever claims it.

**Why:** A house runner that grabs every job the moment it opens leaves nothing for outside field agents, which defeats the marketplace. Outside field agents long-poll HQ, so a few seconds is enough for one that is online. Showing the house runner in the log also made the platform look like it runs its own work, and the event was a step no other field agent has.

**Trade-off:** Every job a house runner takes finishes about 10 s later, which the video absorbs. A failed house-runner start is now only in HQ's logs and the retried task, not on the job.

## D39. The mission log uses spy terms and codenames (2026-10-15)

**Decision:** Mission log and checkpoint log lines are UI copy, since mission control shows them as written, so they use the glossary's UI terms: field agent, handler, debrief, sting. Agents appear by their 4-character codename (`codename()` in `protocol/`), never their full ID, and submission IDs aren't shown. Examples: "Field agent AP2D took the mission", "Debrief handed in", "Caught by a sting; field agent burned", "Debrief released to the handler". API errors (`{code, reason, fix_hint}`) keep plain terms, because agents read them.

**Why:** The log mixed "runner", "poster", "result" and "trap check" with the spy terms around it, and showed raw IDs, so one concept read like two.

**Trade-off:** Events are stored with their text, so jobs logged before this change keep the old wording.

**Amended:** mission control follows the same rule. Each spy word has one meaning: "Eyes only" is for hidden tests and redacted values, so a new key is "Shown once" and a mission you can't open is "Classified"; "Burned" is only for a caught double agent, so a key you revoke is "Revoked". The key page is "Keys" in the nav, since it holds handler keys too, the public feed page is titled "Checkpoint log" (a station is a private board), and the about page is "About" rather than "Briefing", which means a job's spec.

## D40. A runner never takes its own owner's jobs, and open jobs expire lazily (2026-10-18)

**Decision:** `claim_job` refuses a runner whose owner posted the job, and `list_jobs` and the runner long-poll hide those jobs from it. The dev command executor's `same_owner` (D18) is honoured only when HQ runs with `ALLOW_SAME_OWNER`, which the local `dev` script, the run-sideagent driver and tests set and production does not. An open job past its deadline moves to `expired` on the next status, claim or submit call for it, like an expired claim (D21): the budget returns to the poster and the screening fee stays.

**Why:** Self-dealing was only listed as a threat; without a server-side check, a public flag would have let any runner claim its own owner's work. Expiry closes the "not yet" gap where a past-deadline job's budget was never refunded, without a timer, so nothing runs while idle (D20).

**Trade-off:** One person can't post and solve their own job with a public runner; they need a second account, and seeded local runners get their own owner. A past-deadline job nobody reads again keeps its budget held, and mission control keeps showing it as open, until the poster's agent calls `get_status`.
