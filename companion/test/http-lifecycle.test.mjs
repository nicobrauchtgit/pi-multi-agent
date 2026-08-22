import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "../src/constants.mjs";
import { openDatabase } from "../src/db/open.mjs";
import { createStatements } from "../src/db/statements.mjs";
import { ensureCompanionTree } from "../src/fsguard.mjs";
import { homePaths } from "../src/home.mjs";
import { startHttpServer } from "../src/http/server.mjs";
import { createLogger } from "../src/log.mjs";
import { createMetrics } from "../src/metrics.mjs";
import {
  assertMode,
  daemonEntry,
  event,
  ingest,
  repositoryRoot,
  request,
  startDaemon,
  tempAgentDir,
} from "./helpers.mjs";

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [daemonEntry, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

test("health is minimal, ingest-only, loopback, and emits no permissive CORS", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const health = await request(daemon.state);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), [
    "buildVersion",
    "degraded",
    "protocolVersion",
    "ready",
    "schemaVersion",
    "uptimeMs",
  ]);
  assert.equal(health.json.protocolVersion, PROTOCOL_VERSION);
  assert.equal(health.json.buildVersion, BUILD_VERSION);
  assert.equal(health.json.schemaVersion, SCHEMA_VERSION);
  assert.equal(health.text.includes(agentDir), false);
  assert.equal(health.headers["access-control-allow-origin"], undefined);
  const rebound = await request(daemon.state, {
    headers: { Host: "evil.example.com" },
  });
  assert.equal(rebound.status, 400);
  assert.deepEqual(rebound.json, { error: "invalid-host" });

  for (const path of [
    "/",
    "/v1/status",
    "/v1/runs",
    "/index.html",
    "/v1/export",
  ]) {
    const response = await request(daemon.state, { path });
    assert.equal(response.status, 404, path);
    assert.equal(response.text, "");
  }
});

test("ingest enforces exact Host, bearer scope, origin, content type, and body/version bounds", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const body = { v: 1, events: [event()] };
  const baseHeaders = {
    Host: `127.0.0.1:${daemon.state.port}`,
    Authorization: `Bearer ${daemon.token}`,
    "Content-Type": "application/json",
  };

  const { Authorization: _authorization, ...missingHeaders } = baseHeaders;
  const missing = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: missingHeaders,
    body,
  });
  assert.equal(missing.status, 401);
  const readToken = fs.readFileSync(daemon.paths.readToken, "utf8").trim();
  const wrongScope = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: { ...baseHeaders, Authorization: `Bearer ${readToken}` },
    body,
  });
  assert.equal(wrongScope.status, 401);
  const wrongHost = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: { ...baseHeaders, Host: "localhost" },
    body,
  });
  assert.equal(wrongHost.status, 400);
  const origin = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: { ...baseHeaders, Origin: "http://evil.invalid" },
    body,
  });
  assert.equal(origin.status, 403);
  assert.equal(origin.headers["access-control-allow-origin"], undefined);
  const contentType = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: { ...baseHeaders, "Content-Type": "text/plain" },
    body,
  });
  assert.equal(contentType.status, 415);
  const oversized = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: baseHeaders,
    body: "{}",
    contentLength: 2 * 1024 * 1024 + 1,
  });
  assert.equal(oversized.status, 413);
  const newer = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: baseHeaders,
    body: { v: 2, events: [] },
  });
  assert.equal(newer.status, 409);
  const tooMany = await request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: baseHeaders,
    body: {
      v: 1,
      events: Array.from({ length: 129 }, (_, index) =>
        event({ eventId: `e-${index}`, producer: { seq: index } }),
      ),
    },
  });
  assert.equal(tooMany.status, 413);

  const status = await runCli(["status", "--agent-dir", agentDir, "--json"]);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).status.eventCount, 0);
});

test("authenticated ingest persists and acknowledges only after commit", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const first = await ingest(daemon, [event()]);
  assert.equal(first.status, 200);
  assert.equal(first.json.results[0].status, "accepted");
  assert.equal(first.json.currentSeq, 1);
  const duplicate = await ingest(daemon, [event()]);
  assert.equal(duplicate.json.results[0].status, "duplicate");
  assert.equal(duplicate.json.results[0].seq, 1);

  const db = new DatabaseSync(daemon.paths.database, { readOnly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    1,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 1);
  db.close();
});

test("a successful ingest clears transient degraded storage health", async (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const opened = openDatabase(paths.database);
  opened.db.exec("PRAGMA busy_timeout=1");
  const health = { ready: true, degraded: false };
  const token = "a".repeat(43);
  let receivedAt = 1_000;
  const server = await startHttpServer({
    db: opened.db,
    statements: createStatements(opened.db),
    ingestToken: token,
    metrics: createMetrics(paths.metrics),
    logger: createLogger(paths.log),
    health,
    startedAt: Date.now(),
    idleMs: 60_000,
    nextReceivedAt: () => receivedAt++,
    onIdle: () => {},
  });
  t.after(async () => {
    await server.close();
    opened.db.close();
  });
  const local = { state: { port: server.port }, token };
  const blocker = new DatabaseSync(paths.database);
  blocker.exec("BEGIN IMMEDIATE");
  const unavailable = await ingest(local, [event()]);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json, { error: "storage-unavailable" });
  assert.equal((await request(local.state)).json.degraded, true);
  blocker.exec("ROLLBACK");
  blocker.close();

  const recovered = await ingest(local, [
    event({ eventId: "event-after-busy", producer: { seq: 2 } }),
  ]);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.results[0].status, "accepted");
  assert.equal((await request(local.state)).json.degraded, false);
});

test("daemon state is atomic/protected, contains no bearer tokens, and a second starter reuses one writer", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  assert.equal(daemon.state.pid, daemon.child.pid);
  assert.ok(daemon.state.port > 0);
  assertMode(daemon.paths.root, 0o700);
  for (const file of [
    daemon.paths.lock,
    daemon.paths.state,
    daemon.paths.ingestToken,
    daemon.paths.readToken,
    daemon.paths.metrics,
    daemon.paths.database,
  ]) {
    assertMode(file, 0o600);
  }
  const ingestToken = fs.readFileSync(daemon.paths.ingestToken, "utf8").trim();
  const readToken = fs.readFileSync(daemon.paths.readToken, "utf8").trim();
  assert.notEqual(ingestToken, readToken);
  assert.match(ingestToken, /^[A-Za-z0-9_-]{43}$/);
  const stateText = fs.readFileSync(daemon.paths.state, "utf8");
  assert.equal(stateText.includes(ingestToken), false);
  assert.equal(stateText.includes(readToken), false);

  const second = await runCli([
    "start",
    "--agent-dir",
    agentDir,
    "--idle-ms",
    "60000",
  ]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).code, "reused");
  assert.equal(
    JSON.parse(fs.readFileSync(daemon.paths.state, "utf8")).pid,
    daemon.child.pid,
  );

  const rebuild = await runCli(["rebuild", "--agent-dir", agentDir]);
  assert.equal(rebuild.code, 72);
  assert.equal(JSON.parse(rebuild.stderr).error, "daemon-lock-held");
});

test("health probes cannot prevent configured idle exit", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir, ["--idle-ms", "1000"]);
  const probes = setInterval(() => {
    void request(daemon.state).catch(() => {});
  }, 100);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("idle exit timed out")),
        4_000,
      );
      daemon.child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  } finally {
    clearInterval(probes);
  }
  assert.equal(daemon.child.exitCode, 0);
  assert.equal(fs.existsSync(daemon.paths.state), false);
  assert.equal(fs.existsSync(daemon.paths.lock), false);
});

test("shutdown checkpoints SQLite and removes only matching lock/state", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  await ingest(daemon, [event()]);
  await daemon.stop();
  assert.equal(fs.existsSync(daemon.paths.state), false);
  assert.equal(fs.existsSync(daemon.paths.lock), false);
  assert.equal(fs.existsSync(daemon.paths.database), true);
  const checked = await runCli([
    "quick-check",
    "--agent-dir",
    agentDir,
    "--json",
  ]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).quickCheck, "ok");
  const rebuild = await runCli([
    "rebuild",
    "--check",
    "--agent-dir",
    agentDir,
    "--json",
  ]);
  assert.equal(rebuild.code, 0, rebuild.stderr);
  assert.equal(JSON.parse(rebuild.stdout).equal, true);
});

test("seeded credentials never appear in DB, WAL/SHM, logs, metrics, or responses", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const secrets = [
    "SEEDCANARY_AAA_11111",
    "SEEDCANARY_BBB_22222",
    "SEEDCANARY_CCC_33333",
    "SEEDCANARY_DDD_44444",
    "SEEDCANARY_EEE_55555",
    "SEEDCANARY_FFF_66666",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX",
  ];
  const seeded = event({
    kind: "future.secret.kind",
    payload: {
      header: `Authorization: ${secrets[0]} [REDACTED:header]`,
      cookieLine: `Cookie: SESSION=${secrets[1]} [REDACTED:cookie]`,
      assignment: `password=${secrets[2]}[REDACTED:x]`,
      password: [secrets[3]],
      token: { raw: secrets[4] },
      url: `postgres://user:${secrets[5]}[REDACTED:x]@localhost/db`,
      boundary: `${"x".repeat(70 * 1024)} ${secrets[6]}`,
    },
  });
  const oldSentinel = "\r\u0000redaction-json-boundary\u0000";
  const sentinelSeeded = event({
    eventId: "event-sentinel-bypass-corpus",
    producer: { seq: 2 },
    kind: "workflow.phase",
    payload: {
      modelLabel: `${oldSentinel}${oldSentinel}${secrets[7]}${oldSentinel}`,
    },
    capture: { contentMode: "metadata" },
  });
  const response = await ingest(daemon, [seeded, sentinelSeeded]);
  assert.equal(response.status, 200);
  for (const secret of secrets)
    assert.equal(response.text.includes(secret), false);

  const stored = new DatabaseSync(daemon.paths.database, { readOnly: true });
  const rows = stored
    .prepare("SELECT payload_json, redaction_json FROM events ORDER BY seq")
    .all();
  stored.close();
  for (const row of rows) {
    for (const secret of secrets) {
      assert.equal(row.payload_json.includes(secret), false);
      assert.equal(row.redaction_json.includes(secret), false);
    }
  }
  assert.ok(
    rows.some((row) =>
      Object.values(JSON.parse(row.redaction_json).counts).some(
        (count) => count > 0,
      ),
    ),
  );

  const scanFiles = () => {
    for (const file of [
      daemon.paths.database,
      daemon.paths.wal,
      daemon.paths.shm,
      daemon.paths.log,
      daemon.paths.metrics,
    ]) {
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file).toString("utf8");
      for (const secret of secrets)
        assert.equal(bytes.includes(secret), false, file);
    }
  };
  scanFiles();
  await daemon.stop();
  scanFiles();
});

test("security and corruption CLI failures use deterministic machine codes", async (t) => {
  const symlinkAgentDir = tempAgentDir(t);
  fs.mkdirSync(`${symlinkAgentDir}/multi-agent`, { mode: 0o700 });
  fs.symlinkSync(
    symlinkAgentDir,
    `${symlinkAgentDir}/multi-agent/observability`,
    "dir",
  );
  const insecure = await runCli([
    "start",
    "--agent-dir",
    symlinkAgentDir,
    "--idle-ms",
    "60000",
  ]);
  assert.equal(insecure.code, 71);
  assert.equal(JSON.parse(insecure.stderr).error, "symlink-rejected");

  const corruptAgentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, corruptAgentDir);
  await daemon.stop();
  const db = new DatabaseSync(daemon.paths.database);
  db.exec("DROP INDEX events_tool_call_seq");
  db.close();
  const corrupt = await runCli([
    "quick-check",
    "--agent-dir",
    corruptAgentDir,
    "--json",
  ]);
  assert.equal(corrupt.code, 74);
  assert.equal(JSON.parse(corrupt.stderr).error, "index-drift");
});

test("runtime and migration startup failures are machine readable and never delete the DB", async (t) => {
  const agentDir = tempAgentDir(t);
  const failed = await runCli(
    ["start", "--agent-dir", agentDir, "--idle-ms", "60000"],
    {
      PI_OBSERVABILITY_TEST_MIGRATION_FAIL: "1",
    },
  );
  assert.equal(failed.code, 73, failed.stderr);
  assert.equal(JSON.parse(failed.stderr).error, "migration-failed");
  const home = `${agentDir}/multi-agent/observability`;
  const database = `${home}/observability.sqlite3`;
  assert.equal(fs.existsSync(database), true);
  assert.equal(fs.existsSync(`${home}/daemon.json`), false);
  assert.equal(fs.existsSync(`${home}/daemon.lock`), false);
  const db = new DatabaseSync(database);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  db.close();
});
