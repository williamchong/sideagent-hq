#!/usr/bin/env node
// Agent driver for the local Sideagent stack: Firebase emulators, HQ and mission control.
// No dependencies beyond Node 24 (global fetch and WebSocket) and a Chrome binary for `shot`.
//
//   node .claude/skills/run-sideagent/driver.mjs up [--control]   start emulators + HQ (+ mission control)
//   node .claude/skills/run-sideagent/driver.mjs seed             create owners/agents, save keys
//   node .claude/skills/run-sideagent/driver.mjs handler          emulator Google user + owner + keys for mission control
//   node .claude/skills/run-sideagent/driver.mjs post [--as handler]   post a job, wait until open, print its ID
//   node .claude/skills/run-sideagent/driver.mjs smoke [--as handler]  post -> screen -> claim -> submit -> release over REST
//   node .claude/skills/run-sideagent/driver.mjs shot <route> <out.png> [--sign-in] [--wait-text <text>]
//   node .claude/skills/run-sideagent/driver.mjs status | down
//
// Env: HQ_PORT (8080), CONTROL_PORT (3000), GOOGLE_CLOUD_PROJECT (needed for screening), CHROME.
// State (pids, logs, keys) lives in .data/run/, which is gitignored.
/* global process, console, fetch, WebSocket, Buffer, setTimeout, clearTimeout */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUN = join(ROOT, ".data/run");
const HQ_PORT = Number(process.env.HQ_PORT ?? 8080);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 3000);
const HQ = `http://localhost:${HQ_PORT}`;
const CONTROL = `http://localhost:${CONTROL_PORT}`;
const EMULATORS = {
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
};
// corepack sits next to node; the `pnpm` shim on PATH is unreliable in non-interactive shells.
const COREPACK = join(dirname(process.execPath), "corepack");
const JDK21 = "/opt/homebrew/opt/openjdk@21/bin";

mkdirSync(RUN, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidsFile = join(RUN, "pids.json");
const readPids = () => (existsSync(pidsFile) ? JSON.parse(readFileSync(pidsFile, "utf8")) : {});
const savePid = (name, pid) =>
  writeFileSync(pidsFile, JSON.stringify({ ...readPids(), [name]: pid }, null, 2));
const keysFile = join(RUN, "keys.json");
const readKeys = () => (existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, "utf8")) : {});
const saveKeys = (patch) =>
  writeFileSync(keysFile, JSON.stringify({ ...readKeys(), hq: HQ, ...patch }, null, 2));

function portOpenOn(port, host) {
  return new Promise((ok) => {
    const s = createConnection({ port, host });
    s.once("connect", () => (s.destroy(), ok(true)));
    s.once("error", () => ok(false));
  });
}

/** Nuxt binds only [::1] on macOS, so check both loopbacks. */
async function portOpen(port) {
  return (await portOpenOn(port, "127.0.0.1")) || (await portOpenOn(port, "::1"));
}

async function waitFor(what, check, timeoutMs = 90_000, child) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child && child.exitCode !== null) {
      throw new Error(`${what} exited with code ${child.exitCode}; see .data/run/*.log`);
    }
    if (await check().catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Starts a long-running command in its own process group, logging to .data/run/<name>.log. */
function startBg(name, args, env, cwd = ROOT) {
  const log = openSync(join(RUN, `${name}.log`), "w");
  const child = spawn(COREPACK, ["pnpm", ...args], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  savePid(name, child.pid);
  console.log(`${name}: pid ${child.pid}, log .data/run/${name}.log`);
  return child;
}

function javaMajor(bin) {
  const r = spawnSync(join(bin, "java"), ["-version"], { encoding: "utf8" });
  const m = /version "(\d+)/.exec(r.stderr ?? "");
  return m ? Number(m[1]) : 0;
}

async function up(withControl) {
  // HQ spawns `docker` for every check; without it a job sits in test_review forever.
  const docker = spawnSync("docker", ["image", "inspect", "sideagent-sandbox-python:dev"], {
    stdio: "ignore",
  });
  if (docker.error) throw new Error("`docker` is not on PATH; HQ checks need it");
  if (docker.status !== 0) {
    throw new Error("Docker is down or the sandbox image is missing: corepack pnpm sandbox:build");
  }
  if ((await portOpen(8180)) && (await portOpen(9099))) {
    console.log("emulators: already running on 8180/9099, reusing them");
  } else {
    // firebase-tools refuses Java < 21; prefer Homebrew's openjdk@21 when the default is older.
    const javaOnPath = dirname(
      execFileSync("/usr/bin/env", ["sh", "-c", "command -v java"], { encoding: "utf8" }).trim(),
    );
    const env = {};
    if (javaMajor(javaOnPath) < 21) {
      if (!existsSync(join(JDK21, "java")))
        throw new Error("Need Java 21+: brew install openjdk@21");
      env.PATH = `${JDK21}:${process.env.PATH}`;
      env.JAVA_HOME = dirname(JDK21);
    }
    const emulators = startBg("emulators", ["emulators"], env);
    await waitFor(
      "emulators",
      async () => (await portOpen(8180)) && (await portOpen(9099)),
      90_000,
      emulators,
    );
    console.log("emulators: up (UI http://127.0.0.1:4000)");
  }

  if (await portOpen(HQ_PORT)) {
    throw new Error(`Port ${HQ_PORT} is taken (another HQ?). Set HQ_PORT to a free port.`);
  }
  // `start`, not `dev`: dev runs `tsx watch`, which restarts HQ (killing inline pipeline steps)
  // whenever anything in hq/ or protocol/ is saved.
  const hq = startBg("hq", ["--filter", "@sideagent/hq", "start"], {
    ...EMULATORS,
    PORT: String(HQ_PORT),
    CONTROL_ORIGIN: CONTROL,
  });
  await waitFor("HQ /healthz", async () => (await fetch(`${HQ}/healthz`)).ok, 90_000, hq);
  console.log(`hq: up at ${HQ} (REST ${HQ}/v1, MCP ${HQ}/mcp)`);
  if (!process.env.GOOGLE_CLOUD_PROJECT && !process.env.GEMINI_API_KEY) {
    console.log(
      "hq: WARNING no GOOGLE_CLOUD_PROJECT/GEMINI_API_KEY; jobs will stick in `screening`",
    );
  }

  if (withControl) {
    if (await portOpen(CONTROL_PORT))
      throw new Error(`Port ${CONTROL_PORT} is taken. Set CONTROL_PORT.`);
    const control = startBg(
      "control",
      ["--filter", "@sideagent/control", "dev", "--port", String(CONTROL_PORT)],
      {
        NUXT_PUBLIC_HQ_URL: HQ,
      },
    );
    await waitFor("mission control", async () => (await fetch(CONTROL)).ok, 180_000, control);
    console.log(`control: up at ${CONTROL}`);
  }
}

function down() {
  for (const [name, pid] of Object.entries(readPids())) {
    try {
      process.kill(-pid, "SIGTERM"); // whole process group: pnpm -> node/java children
      console.log(`${name}: stopped (pgid ${pid})`);
    } catch {
      console.log(`${name}: not running`);
    }
  }
  rmSync(pidsFile, { force: true });
}

async function status() {
  console.log(`emulators firestore:8180 ${await portOpen(8180)} auth:9099 ${await portOpen(9099)}`);
  const hq = await fetch(`${HQ}/healthz`).then(
    (r) => r.ok,
    () => false,
  );
  console.log(`hq ${HQ} healthz ${hq}`);
  console.log(`control ${CONTROL} ${await portOpen(CONTROL_PORT)}`);
  console.log(`pids ${JSON.stringify(readPids())}`);
}

function seed() {
  const out = execFileSync(COREPACK, ["pnpm", "--filter", "@sideagent/hq", "seed"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(HQ_PORT) },
    encoding: "utf8",
  });
  const key = (re) => re.exec(out)?.[1];
  const keys = {
    poster: key(/Poster agent \S+: (sk_\S+)/),
    runner: key(/Runner agent \S+: (sk_\S+)/),
    house: key(/HOUSE_RUNNER_API_KEY=(sk_\S+)/),
    double: key(/HOUSE_RUNNER_DOUBLE_AGENT_API_KEY=(sk_\S+)/),
  };
  if (!keys.poster || !keys.runner) throw new Error(`Could not parse seed output:\n${out}`);
  saveKeys(keys);
  console.log(out);
  console.log("Keys saved to .data/run/keys.json");
}

// A fixed fake Google account in the Auth emulator; mission control signs in as it with `shot --sign-in`.
const HANDLER = {
  sub: "sideagent-driver",
  email: "handler@example.com",
  name: "Driver Handler",
  email_verified: true,
};

// A second account: a runner cannot claim its own owner's jobs, so the handler's runner key
// belongs to this owner.
const FIELD_AGENT = {
  sub: "sideagent-driver-field",
  email: "field@example.com",
  name: "Driver Field Agent",
  email_verified: true,
};

/** Signs `user` in to the Auth emulator over REST and creates its owner; returns an owner API call. */
async function emulatorSignIn(user) {
  const auth = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-api-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(JSON.stringify(user))}&providerId=google.com`,
        requestUri: "http://localhost",
        returnSecureToken: true,
      }),
    },
  ).then((r) => r.json());
  if (!auth.idToken) throw new Error(`Auth emulator sign-in failed: ${JSON.stringify(auth)}`);
  const owner = (method, path, body) => api(auth.idToken, method, `/owner${path}`, body);
  const me = await owner("POST", ""); // `/v1/owner/` (trailing slash) is a 404
  return { owner, me };
}

/** Creates HANDLER's owner and poster key, and a runner key under FIELD_AGENT's owner. */
async function handler() {
  const { owner, me } = await emulatorSignIn(HANDLER);
  const { owner: fieldOwner } = await emulatorSignIn(FIELD_AGENT);
  const poster = await owner("POST", "/agents", { role: "poster" });
  const runner = await fieldOwner("POST", "/agents", { role: "runner" });
  saveKeys({ handler: { poster: poster.api_key, runner: runner.api_key } });
  console.log(`owner ${me.owner_id} "${me.display_name}" balance ${me.balance}`);
  console.log("poster + runner keys saved to .data/run/keys.json under `handler`");
}

async function api(key, method, path, body) {
  const res = await fetch(`${HQ}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function follow(key, jobId, waiting, timeoutMs = 300_000) {
  const start = Date.now();
  let last;
  for (;;) {
    const s = await api(key, "GET", `/jobs/${jobId}`);
    if (s.state !== last)
      console.log(`  state: ${s.state} (${((Date.now() - start) / 1000).toFixed(1)} s)`);
    last = s.state;
    if (!waiting.includes(s.state)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`Job ${jobId} stuck in ${s.state}`);
    await sleep(1000);
  }
}

function keysFor(as) {
  const all = readKeys();
  const keys = as === "handler" ? all.handler : all;
  if (!keys?.poster) throw new Error(`No keys for ${as ?? "seed"}; run \`${as ?? "seed"}\` first`);
  return keys;
}

/** Posts the add-two-numbers job and waits until screening opens it; returns its ID. */
async function post(keys) {
  const t = (n, a, b) => `def test_${n}():\n    assert add(${a}, ${b}) == ${a + b}\n`;
  const job = await api(keys.poster, "POST", "/jobs", {
    type: "code.implement",
    runtime: "python",
    title: "Add two numbers",
    spec: "Write add(a, b) in solution.py that returns a + b.",
    public_tests: [
      { path: "test_public.py", content: `from solution import add\n\n${t("small", 1, 2)}` },
    ],
    hidden_tests: [
      {
        path: "test_hidden.py",
        content: `from solution import add\n\n${t("zero", 0, 0)}\n${t("neg", -1, -2)}`,
      },
    ],
    budget: 10,
    deadline: new Date(Date.now() + 3600_000).toISOString(),
    idempotency_key: `smoke-${Date.now()}`,
  });
  console.log(`posted ${job.job_id}`);
  const screened = await follow(keys.poster, job.job_id, ["draft", "screening", "test_review"]);
  if (screened.state !== "open")
    throw new Error(`Not open after screening: ${JSON.stringify(screened)}`);
  return job.job_id;
}

/** Full lifecycle over REST. Needs Gemini (screening) and Docker (checks). */
async function smoke(as) {
  const keys = keysFor(as);
  const jobId = await post(keys);
  const claim = await api(keys.runner, "POST", `/jobs/${jobId}/claim`);
  console.log(
    `claimed, ${claim.attempts_left} attempts; runner sees spec: ${JSON.stringify(claim.job.spec)}`,
  );
  await api(keys.runner, "POST", `/jobs/${jobId}/submissions`, {
    result: [{ path: "solution.py", content: "def add(a, b):\n    return a + b\n" }],
    idempotency_key: `smoke-${jobId}`,
  });
  const done = await follow(keys.poster, jobId, ["claimed", "submitted", "checking", "passed"]);
  console.log(JSON.stringify(done, null, 2));
  console.log(`balance poster ${(await api(keys.poster, "GET", "/balance")).balance}`);
  if (done.state !== "released") process.exitCode = 1;
}

// --- Browser: minimal Chrome DevTools Protocol client --------------------------------------

function chromePath() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No Chrome found; set CHROME to a Chrome/Chromium binary");
  return found;
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "sideagent-chrome-"));
  const proc = spawn(
    chromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = new Promise((ok) => proc.once("exit", ok));
  const close = async () => {
    ws?.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
      await exited; // Chrome keeps writing its profile until it exits
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  let ws;
  try {
    const wsUrl = await new Promise((ok, fail) => {
      let err = "";
      setTimeout(() => fail(new Error(`Chrome never opened DevTools:\n${err}`)), 15_000);
      proc.stderr.on("data", (d) => {
        if (err.includes("DevTools listening")) return; // keep draining, stop buffering
        err += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) ok(m[1]);
      });
      proc.once("exit", () => fail(new Error(`Chrome exited:\n${err}`)));
    });
    ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", () => fail(new Error(`Cannot connect to ${wsUrl}`)), {
        once: true,
      });
    });
  } catch (e) {
    await close();
    throw e;
  }
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(JSON.stringify(msg.error)));
      else ok(msg.result);
    } else for (const l of listeners) l(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const n = ++id;
      if (process.env.DEBUG) console.error(`cdp> ${method}`);
      const timer = setTimeout(
        () => (pending.delete(n), fail(new Error(`CDP ${method} timed out`))),
        20_000,
      );
      pending.set(n, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
  /** Subscribes to CDP events; returns an unsubscribe function. */
  const on = (l) => {
    listeners.push(l);
    return () => listeners.splice(listeners.indexOf(l), 1);
  };
  return { send, on, close };
}

async function attachPage(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);
  await call("Runtime.enable");
  await call("Page.enable");
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      // Without a user gesture, signInWithPopup's window.open is popup-blocked and nothing happens.
      userGesture: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitText = async (text, timeoutMs = 30_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Case-insensitive: innerText applies CSS text-transform, so "Dead drop" renders as "DEAD DROP".
      const probe = `document.body?.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
      if (await evaluate(probe).catch(() => false)) return;
      await sleep(300);
    }
    throw new Error(
      `Text not found: ${text}\n--- page text ---\n${await evaluate("document.body?.innerText")}`,
    );
  };
  /** Clicks the first button/link whose visible text contains `text`. */
  const clickText = (text) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('button, a, [role=button]')]
        .find((e) => e.innerText.trim().includes(${JSON.stringify(text)}));
      if (!el) throw new Error('No clickable element with text ' + ${JSON.stringify(text)});
      el.click();
      return true;
    })()`);
  return { call, evaluate, waitText, clickText };
}

/** Signs in through the Auth emulator's Google popup. */
async function signIn(cdp, page) {
  let timer, off;
  const popupTarget = new Promise((ok, fail) => {
    timer = setTimeout(() => fail(new Error("Sign-in popup never opened")), 20_000);
    off = cdp.on((msg) => {
      // The popup is created as about:blank and only then navigates to the emulator's handler.
      if (msg.method === "Target.targetCreated" && msg.params.targetInfo.openerId) {
        ok(msg.params.targetInfo.targetId);
      }
    });
  });
  let popupId;
  try {
    [, popupId] = await Promise.all([page.clickText("Sign in"), popupTarget]);
  } finally {
    clearTimeout(timer);
    off();
  }
  const popup = await attachPage(cdp, popupId);
  await popup.waitText("Add new account");
  // The account list is static HTML; its click handlers bind only once the page's scripts load.
  await waitFor(
    "sign-in popup scripts",
    () => popup.evaluate("document.readyState === 'complete'"),
    20_000,
  );
  await sleep(500);
  // Pick the driver's handler account (created by `handler`) so the browser sees the jobs that
  // `smoke --as handler` posts; else the first existing account; else auto-generate a new one.
  const reused = await popup.evaluate(`(() => {
    const all = [...document.querySelectorAll('.js-reuse-account')];
    const el = all.find((e) => decodeURIComponent(e.dataset.idToken).includes(${JSON.stringify(HANDLER.email)})) ?? all[0];
    if (el) el.click();
    return !!el;
  })()`);
  if (!reused) {
    await popup.evaluate(`document.querySelector('#add-account-button').click()`);
    await popup.waitText("Auto-generate user information");
    await popup.evaluate(`document.querySelector('#autogen-button').click()`);
    await sleep(300);
    await popup.evaluate(`document.querySelector('#sign-in').click()`);
  }
}

async function shot(route, out, flags) {
  const cdp = await launchChrome();
  try {
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const page = await attachPage(cdp, targetId);
    await page.call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.call("Page.navigate", { url: CONTROL });
    if (flags.signIn) {
      await page.waitText("Sign in");
      await signIn(cdp, page);
      await page.waitText("Sign out");
    }
    // Firebase keeps the session in IndexedDB, so a full load of another route stays signed in.
    if (route !== "/") await page.call("Page.navigate", { url: CONTROL + route });
    await page.waitText("Sideagent"); // app shell rendered
    if (flags.waitText) await page.waitText(flags.waitText);
    await sleep(1500); // let live Firestore listeners and transitions settle
    const { data } = await page.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`saved ${out}`);
    console.log(
      "--- page text ---\n" + (await page.evaluate("document.body.innerText")).slice(0, 2000),
    );
  } finally {
    await cdp.close();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const commands = {
  up: () => up(flag("--control")),
  down,
  status,
  seed,
  handler,
  post: async () => console.log(await post(keysFor(opt("--as")))),
  smoke: () => smoke(opt("--as")),
  shot: () =>
    shot(rest[0] ?? "/", rest[1] ?? join(RUN, "shot.png"), {
      signIn: flag("--sign-in"),
      waitText: opt("--wait-text"),
    }),
};
if (!commands[cmd]) {
  console.error(`usage: driver.mjs ${Object.keys(commands).join("|")}`);
  process.exit(2);
}
await commands[cmd]();
