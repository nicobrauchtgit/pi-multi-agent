import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { event, repositoryRoot, waitFor } from "./helpers.mjs";
import { homePaths } from "../src/home.mjs";

const chromeBinary = "/opt/homebrew/bin/chrome-devtools";
const heliumBinary = "/Applications/Helium.app/Contents/MacOS/Helium";
const screenshotDir = path.join(repositoryRoot, ".companion-test", "d3-live");

function chrome(args, options = {}) {
  try {
    return execFileSync(chromeBinary, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 30_000,
      env: { ...process.env, CI: "1" },
    });
  } catch {
    throw new Error(`chrome-command-failed:${args[0]}`);
  }
}

function chromeJson(args, options) {
  return JSON.parse(chrome([...args, "--output-format", "json"], options));
}

function evaluated(functionText) {
  const result = chromeJson(["evaluate_script", functionText]);
  const match = /```json\n([\s\S]*?)\n```/.exec(result.message ?? "");
  if (!match) throw new Error("chrome-evaluation-result-invalid");
  return JSON.parse(match[1]);
}

async function waitForBrowser(functionText, timeoutMs = 10_000) {
  return waitFor(() => (evaluated(functionText) ? true : undefined), timeoutMs);
}

function request(state, options = {}) {
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: state.port,
        method: options.method ?? "GET",
        path: options.path ?? "/healthz",
        headers: {
          Host: `127.0.0.1:${state.port}`,
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            text,
            json: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function startDaemon(agentDir) {
  const child = spawn(
    process.execPath,
    [
      path.join(repositoryRoot, "companion", "daemon.mjs"),
      "start",
      "--agent-dir",
      agentDir,
      "--idle-ms",
      "60000",
    ],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
  const paths = homePaths(agentDir);
  const state = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(paths.state, "utf8"));
    } catch {
      if (child.exitCode !== null) throw new Error("live-daemon-start-failed");
      return undefined;
    }
  });
  const ingestToken = fs.readFileSync(paths.ingestToken, "utf8").trim();
  const readToken = fs.readFileSync(paths.readToken, "utf8").trim();
  return {
    child,
    paths,
    state,
    ingestToken,
    readToken,
    async stop() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("live-daemon-stop-timeout")),
            5_000,
          ),
        ),
      ]);
    },
  };
}

function liveEvents() {
  const root = { runId: "pi-run:d3-live-parent", parentRunId: null };
  const workflow = {
    runId: "wf_d3live1234",
    parentRunId: "pi-run:d3-live-parent",
  };
  const codexRun = {
    runId: "sa_d3-live-codex",
    parentRunId: "pi-run:d3-live-parent",
  };
  const events = [];
  const add = (kind, ids, payload, options = {}) => {
    const sequence = events.length + 1;
    events.push(
      event({
        eventId: `event-d3-live-${sequence}`,
        kind,
        producer: { seq: sequence },
        ids,
        payload,
        project: {
          id: "d3-live-supplied",
          root: repositoryRoot,
        },
        capture: options.capture ?? {
          contentMode: "metadata",
          truncated: false,
        },
      }),
    );
  };
  add("run.started", root, {
    sessionId: "d3-live-parent",
    name: "Parent Pi session",
  });
  add(
    "turn.started",
    { ...root, turnId: "turn_d3-live-parent" },
    { turnNumber: 1 },
  );
  add("workflow.started", workflow, {
    name: "D3 Live Workflow",
    background: false,
    phaseCount: 3,
  });
  add("workflow.phase", workflow, { phase: "Implementation" });
  add(
    "workflow.log",
    workflow,
    { message: "bounded workflow log" },
    {
      capture: {
        contentMode: "metadata",
        truncated: true,
        truncatedFields: ["payload.message"],
        fieldBytes: { "payload.message": { original: 9000, stored: 20 } },
      },
    },
  );
  for (const [index, backend] of ["pi", "claude"].entries()) {
    const agentId = `agent_d3-live-${backend}`;
    const ids = {
      ...workflow,
      agentId,
      turnId: `turn_d3-live-${backend}`,
    };
    add("agent.created", ids, {
      displayId: `wf-${index + 1}`,
      workflowAgentIndex: index,
      origin: "workflow",
      backend,
      title: `${backend} metadata worker`,
      resumed: false,
    });
    add("agent.run_started", ids, {
      displayId: `wf-${index + 1}`,
      backend,
      turnNumber: 1,
    });
    add("agent.message", ids, {
      displayId: `wf-${index + 1}`,
      messageUnavailable: true,
    });
    add("agent.settled", ids, {
      displayId: `wf-${index + 1}`,
      status: "done",
      outcome: "completed",
      finalPreview: `${backend} bounded preview`,
    });
  }
  add("artifact.recovered", workflow, {
    sourceKind: "test-metadata-only",
    reference: "artifact-reference-present",
  });
  add("workflow.settled", workflow, { status: "completed" });
  const codexIds = {
    ...codexRun,
    agentId: "agent_d3-live-codex",
    turnId: "turn_d3-live-codex",
  };
  add("agent.created", codexIds, {
    displayId: "sa-codex",
    origin: "model",
    backend: "codex",
    title: "Codex metadata worker",
    resumed: false,
  });
  add("agent.run_started", codexIds, {
    displayId: "sa-codex",
    backend: "codex",
    turnNumber: 1,
  });
  add("agent.message", codexIds, {
    displayId: "sa-codex",
    messageUnavailable: true,
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
  });
  add("agent.settled", codexIds, {
    displayId: "sa-codex",
    status: "error",
    outcome: "failed",
    error: "deliberate live acceptance failure",
  });
  add("run.settled", root, { status: "completed" });
  return events;
}

function screenshot(name) {
  const file = path.join(screenshotDir, name);
  const result = chrome([
    "take_screenshot",
    "--fullPage",
    "true",
    "--filePath",
    file,
    "--output-format",
    "json",
  ]);
  assert.equal(result.includes("Access denied"), false);
  assert.equal(fs.existsSync(file), true);
}

function navigate(url) {
  chrome([
    "navigate_page",
    "--url",
    url,
    "--timeout",
    "10000",
    "--output-format",
    "json",
  ]);
}

let daemon;
let restarted;
let oldReadToken;
const agentDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-observability-d3-live-"),
);
fs.chmodSync(agentDir, 0o700);
fs.rmSync(screenshotDir, { recursive: true, force: true });
fs.mkdirSync(screenshotDir, { recursive: true });

try {
  chrome(["stop"]);
} catch {
  // A stale browser daemon is optional.
}

try {
  daemon = await startDaemon(agentDir);
  const ingest = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    token: daemon.ingestToken,
    body: { v: 1, events: liveEvents() },
  });
  assert.equal(ingest.status, 200);
  assert.ok(ingest.json.accepted >= 20);
  const seededRuns = await request(daemon.state, {
    path: "/v1/runs?limit=50",
    token: daemon.readToken,
  });
  assert.equal(seededRuns.status, 200);
  assert.equal(seededRuns.json.runs.length, 3);

  chrome(
    [
      "start",
      "--headless",
      "--executablePath",
      heliumBinary,
      "--usageStatistics=false",
      "--performanceCrux=false",
      "--redactNetworkHeaders=true",
      "--allowUnrestrictedPaths=true",
    ],
    { timeout: 60_000 },
  );

  navigate(`http://127.0.0.1:${daemon.state.port}/#invalid`);
  await waitForBrowser(
    "() => document.body.textContent.includes('Read capability required') && location.hash === ''",
  );
  assert.equal(
    evaluated("() => document.querySelectorAll('.run-card').length"),
    0,
  );

  navigate(`http://127.0.0.1:${daemon.state.port}/#${daemon.readToken}`);
  await waitForBrowser(
    "() => document.querySelectorAll('.run-card').length >= 3",
  );
  const bootstrap = evaluated(`() => ({
    hashRemoved: location.hash === '',
    urlClean: !/[#?][A-Za-z0-9_-]{43}/.test(location.href),
    domClean: document.querySelector('[data-token], [data-capability]') === null,
    localClean: Object.keys(localStorage).length === 0,
    sessionClean: Object.keys(sessionStorage).length === 0,
    cookieClean: document.cookie === ''
  })`);
  assert.deepEqual(bootstrap, {
    hashRemoved: true,
    urlClean: true,
    domClean: true,
    localClean: true,
    sessionClean: true,
    cookieClean: true,
  });
  const bootstrapSnapshot = chromeJson(["take_snapshot"]);
  assert.equal(
    JSON.stringify(bootstrapSnapshot).includes(daemon.readToken),
    false,
  );
  screenshot("01-runs.png");

  evaluated(`() => {
    document.querySelector('#filter-status').value = 'failed';
    document.querySelector('#filter-kind').value = 'standalone';
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply filters').click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.querySelectorAll('.run-card').length === 1 && document.body.textContent.includes('sa_d3-live-codex')",
  );
  screenshot("02-status-kind-filter.png");

  evaluated(`() => {
    const input = document.querySelector('.toolbar input');
    input.value = 'no-such-project';
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply filters').click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.body.textContent.includes('No runs match the current filters.')",
  );
  screenshot("02-empty-filter.png");

  evaluated(`() => {
    const input = document.querySelector('.toolbar input');
    input.value = '';
    document.querySelector('#filter-status').value = '';
    document.querySelector('#filter-kind').value = '';
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Apply filters').click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.querySelectorAll('.run-card').length >= 3",
  );
  evaluated(`() => {
    const card = [...document.querySelectorAll('.run-card')].find((candidate) => candidate.textContent.includes('D3 Live Workflow'));
    card.querySelector('button').click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.body.textContent.includes('Run timeline') && document.querySelectorAll('.lane').length >= 3",
  );
  assert.equal(
    evaluated(
      "() => ['metadata-only', 'truncated', 'omitted', 'recovered'].every((badge) => document.body.textContent.includes(badge))",
    ),
    true,
  );
  screenshot("03-run-timeline.png");

  evaluated(`() => {
    [...document.querySelectorAll('button')].find((button) => button.textContent.startsWith('Open wf-')).click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.body.textContent.includes('Agent detail')",
  );
  screenshot("04-agent-detail.png");

  evaluated(`() => {
    [...document.querySelectorAll('[data-view]')].find((button) => button.dataset.view === 'health').click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.body.textContent.includes('Companion daemon')",
  );
  screenshot("05-system-health.png");

  chrome([
    "emulate",
    "--networkConditions",
    "Slow 3G",
    "--output-format",
    "json",
  ]);
  evaluated(`() => {
    [...document.querySelectorAll('[data-view]')].find((button) => button.dataset.view === 'runs').click();
    return true;
  }`);
  await waitForBrowser(
    "() => document.body.textContent.includes('Loading run projections')",
  );
  screenshot("06-loading.png");
  chrome(["emulate", "--output-format", "json"]);
  await waitForBrowser(
    "() => document.querySelectorAll('.run-card').length >= 3",
    15_000,
  );

  oldReadToken = daemon.readToken;
  await daemon.stop();
  daemon = undefined;
  await waitForBrowser(
    "() => document.querySelector('#connection-state').textContent.includes('interrupted') && document.body.textContent.includes('stale snapshot')",
    10_000,
  );
  screenshot("07-daemon-error.png");

  restarted = await startDaemon(agentDir);
  const stale = await request(restarted.state, {
    path: "/v1/status",
    token: oldReadToken,
  });
  assert.equal(stale.status, 401);
  navigate(`http://127.0.0.1:${restarted.state.port}/#${restarted.readToken}`);
  await waitForBrowser(
    "() => document.querySelectorAll('.run-card').length >= 3",
  );
  screenshot("08-restarted.png");

  const network = chromeJson([
    "list_network_requests",
    "--includePreservedRequests",
    "true",
  ]);
  const urls = (network.networkRequests ?? []).map((entry) => entry.url);
  assert.ok(urls.length > 0);
  const tokenNavigationUrls = urls.filter(
    (url) => url.includes(oldReadToken) || url.includes(restarted.readToken),
  );
  assert.ok(tokenNavigationUrls.length <= 2);
  assert.equal(
    tokenNavigationUrls.every(
      (url) =>
        !url.includes("?") &&
        new URL(url).hostname === "127.0.0.1" &&
        new URL(url).pathname === "/",
    ),
    true,
  );
  assert.equal(
    urls
      .filter((url) => new URL(url).pathname !== "/")
      .some(
        (url) =>
          url.includes(oldReadToken) || url.includes(restarted.readToken),
      ),
    false,
  );
  assert.equal(
    urls.every(
      (url) =>
        url.startsWith(`http://127.0.0.1:${restarted.state.port}/`) ||
        url.startsWith(`http://127.0.0.1:`),
    ),
    true,
  );
  const consoleMessages = chromeJson([
    "list_console_messages",
    "--includePreservedMessages",
    "true",
  ]);
  const consoleText = JSON.stringify(consoleMessages);
  assert.equal(consoleText.includes(oldReadToken), false);
  assert.equal(consoleText.includes(restarted.readToken), false);
  assert.equal(/uncaught|unhandled/i.test(consoleText), false);

  process.stdout.write(
    `${JSON.stringify({ ok: true, screenshots: path.relative(repositoryRoot, screenshotDir) })}\n`,
  );
} finally {
  try {
    if (daemon) await daemon.stop();
  } catch {
    // Cleanup continues.
  }
  try {
    if (restarted) await restarted.stop();
  } catch {
    // Cleanup continues.
  }
  try {
    chrome(["stop"]);
  } catch {
    // Cleanup continues.
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
}
