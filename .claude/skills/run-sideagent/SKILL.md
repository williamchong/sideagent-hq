---
name: run-sideagent
description: Run, start, drive and screenshot the local Sideagent stack (Firebase emulators, HQ REST/MCP server, mission control dashboard, field CLI). Use when asked to run HQ, start mission control, post a job end to end, take a screenshot of the dashboard, run the field agent against a local job, or confirm a change works in the real app rather than only in tests.
---

# Run Sideagent locally

Sideagent is a pnpm workspace: **HQ** (Hono REST + MCP server), **mission control** (Nuxt SPA
reading Firestore live) and the **field CLI** (a runner agent), all backed by the Firebase
emulators. The agent path is `.claude/skills/run-sideagent/driver.mjs`: it starts the stack in
the background, seeds keys, drives a job through its whole lifecycle over REST, and screenshots
mission control through headless Chrome (raw DevTools protocol, no Playwright needed).

Paths are relative to the repo root. Verified on macOS (arm64) with Node 24.15.

## Prerequisites

- Node 24 (`.nvmrc`). Call pnpm through corepack; the `pnpm` shim breaks in non-interactive shells:
  `export PATH=~/.nvm/versions/node/v24.15.0/bin:$PATH` and then `corepack pnpm ...`.
- **Java 21+** for the emulators. If `java -version` says 17, the driver uses
  `/opt/homebrew/opt/openjdk@21` automatically (`brew install openjdk@21` if it is missing).
- Docker running, with the sandbox image: `corepack pnpm sandbox:build` (checks run in it).
- Gemini for screening: `gcloud auth application-default login` plus
  `GOOGLE_CLOUD_PROJECT=sideagent-hq`. Without it, HQ starts but jobs stay in `screening`.
- Google Chrome (for `shot`; set `CHROME=/path/to/chrome` elsewhere).

```sh
export PATH=~/.nvm/versions/node/v24.15.0/bin:$PATH
corepack pnpm install
```

## Run (agent path)

```sh
export PATH=~/.nvm/versions/node/v24.15.0/bin:$PATH
export GOOGLE_CLOUD_PROJECT=sideagent-hq HQ_PORT=8090 CONTROL_PORT=3020   # free ports; see Gotchas
D=.claude/skills/run-sideagent/driver.mjs

node $D up --control      # emulators (reused if already up) + HQ + mission control, logs in .data/run/
node $D handler           # emulator Google user "Driver Handler" + its owner + poster key; runner key under "Driver Field Agent"
node $D smoke --as handler   # post -> screening (Gemini) -> claim -> submit -> Docker check -> released
node $D shot / .data/run/board.png --sign-in --wait-text "Dead drop"
node $D shot /ledger .data/run/ledger.png --sign-in
node $D status
node $D down              # stops what `up` started (process groups); leaves pre-existing emulators alone
```

- `smoke` prints each state change with timings and the final job JSON (events, check summary,
  released result); exit code 1 unless the job ends `released`. Takes about 4 s.
- `shot <route> <out.png> [--sign-in] [--wait-text <text>]` saves a 1440x900 PNG and prints the
  page's text, so you can check content without opening the image. `--sign-in` clicks
  "Sign in with Google", picks the Driver Handler account in the Auth emulator popup, and waits
  for "Sign out". Routes: `/` (mission map), `/feed`, `/ledger`, `/agents`.
- `seed` runs `hq seed` (local dev owner, poster, runner, house runner and double agent keys)
  and saves the keys to `.data/run/keys.json`. `smoke`/`post` without `--as handler` use them.
  Those jobs belong to a different owner, so they **don't appear** in mission control.
- `post --as handler` posts the same job, waits until it is `open` and prints its ID, for
  driving it with a real runner:

```sh
JOB=$(node $D post --as handler | tail -1)
KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".data/run/keys.json")).handler.runner)')
SIDEAGENT_HQ_URL=http://localhost:8090 SIDEAGENT_API_KEY=$KEY SIDEAGENT_MODEL_BACKEND=vertex \
  SIDEAGENT_MODEL=gemini-2.5-flash-lite corepack pnpm field --once --job $JOB
```

That runs the field agent loop (read_file, write_file, run_public_tests in Docker, submit) and
ends with `Check passed: 3/3 tests` / `Job is released` in about 8 s.

Raw REST is also fine: `curl localhost:8090/healthz`, and `/v1/...` with
`authorization: Bearer <key>` from `.data/run/keys.json`. MCP is at `/mcp`.

## Run (human path)

`corepack pnpm emulators`, `corepack pnpm --filter @sideagent/hq dev`,
`corepack pnpm --filter @sideagent/control dev`, then open http://localhost:3000 and sign in
through the emulator's Google page. Ports are 8080 (HQ) and 3000 (mission control).

## Test

`pnpm test` starts its own emulators on 8180/9099 (so stop yours first), needs Java 21 itself,
and runs a nested `pnpm -r test` that hits the broken `pnpm` shim. Put corepack shims in a
gitignored dir first on PATH:

```sh
node $D down
export PATH=/opt/homebrew/opt/openjdk@21/bin:~/.nvm/versions/node/v24.15.0/bin:$PATH
mkdir -p .data/run/bin && corepack enable --install-directory .data/run/bin pnpm
export PATH=$PWD/.data/run/bin:$PATH
pnpm typecheck && pnpm lint && pnpm test     # ~234 tests across protocol, field, hq
```

## Gotchas

- **Other sessions share this checkout and its ports.** An HQ is often already on 8080 and
  emulators on 8180/9099. `up` reuses running emulators but refuses a taken `HQ_PORT` or
  `CONTROL_PORT`; pick free ones (8090/3020). A `healthz` probe on a taken port answers from
  the *other* HQ, so check the port before trusting it.
- **Don't use `hq dev` for agent runs.** It is `tsx watch`, so any save in `hq/` or `protocol/`
  (by you or another session) restarts HQ and drops in-flight inline pipeline steps; a demo
  then dies with `ECONNREFUSED` minutes in. The driver uses `hq start` with the emulator env
  set explicitly (`start` doesn't default `FIRESTORE_EMULATOR_HOST` the way `dev` does).
- **`hq start` also doesn't reload**, so restart (`down`, `up`) after changing HQ code.
- **`pnpm demo:escrow` is stale.** It claims right after posting and gets
  `409 Job is screening` since screening was added; `smoke` does the same flow but waits.
  `pnpm demo:counterintel` is current but takes minutes (needs `PORT=$HQ_PORT`).
- **Sign-in popup quirks** (all handled in `driver.mjs`): a click from `Runtime.evaluate` needs
  `userGesture: true` or `signInWithPopup` is silently popup-blocked; the popup target is
  created as `about:blank`, so match it by `openerId`, not URL; the emulator's account list is
  static HTML whose click handlers bind only after load, so wait for `readyState` first.
- **Mission control only shows the signed-in owner's jobs.** Use `handler` + `--as handler`.
  The handler account is a fake Google identity created over the Auth emulator REST API
  (`accounts:signInWithIdp` with an unsigned JSON `id_token`); `shot --sign-in` selects it by email.
- `POST /v1/owner/` (trailing slash) is a 404; the route is `POST /v1/owner`.
- `--wait-text` is case-insensitive because `innerText` applies CSS `text-transform`
  ("Dead drop" renders as "DEAD DROP").
- The emulators keep data until stopped, so job counts and balances accumulate across runs.
  `seed` makes a new owner each time; `handler` reuses one owner but adds new keys.

## Troubleshooting

- `firebase-tools no longer supports Java version before 21` → Java 17 on PATH; run via the
  driver or `PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH corepack pnpm emulators`.
- `pnpm test` → `/Users/.../.local/bin/pnpm:8: no such file or directory` (exit 127) → the
  nested `pnpm -r test` found the broken shim; use the `.data/run/bin` shims from Test.
- Job stuck in `test_review` and `spawn docker ENOENT` in `.data/run/hq.log` → HQ was started
  without `docker` on PATH (e.g. a stripped `env -i` shell). `up` now refuses to start then.
- `Port 8080 is taken (another HQ?)` → set `HQ_PORT` (and `CONTROL_PORT`) to free ports.
- `listen EADDRINUSE :::8090` in `.data/run/hq.log` → an older HQ still holds the port. Find it
  with `lsof -nP -iTCP:8090 -sTCP:LISTEN` and stop it if it is yours.
- `smoke` stuck at `state: screening` → no Gemini credentials (`GOOGLE_CLOUD_PROJECT` unset when
  `up` ran, or ADC expired); restart with it set.
- `trap writer failed ... ZodError` in `hq.log` → Gemini returned a trap test name that fails the
  schema; the job still proceeds without trap checks.
- `Text not found: Sign out` from `shot --sign-in` → the popup click didn't take. Rerun with
  `DEBUG=1` to trace CDP calls; the error prints the page text it saw.
