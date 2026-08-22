import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createConfigLoader } from "../src/config.mjs";
import { openDatabase } from "../src/db/open.mjs";
import { createReadStatements } from "../src/db/read-statements.mjs";
import { createStatements } from "../src/db/statements.mjs";
import { ensureCompanionTree } from "../src/fsguard.mjs";
import { homePaths } from "../src/home.mjs";
import { createReadRouter, createSizeSnapshot } from "../src/http/read.mjs";
import { startHttpServer } from "../src/http/server.mjs";
import { loadStaticAssets } from "../src/http/static.mjs";
import { createLogger } from "../src/log.mjs";
import { createMetrics } from "../src/metrics.mjs";
import {
  event,
  ingest,
  readRequest,
  request,
  startDaemon,
  tempAgentDir,
} from "./helpers.mjs";

function seededEvents() {
  const runId = "wf_d3abcdef";
  const agentId = "agent_d3-opaque";
  const baseIds = { runId, parentRunId: "pi-run:d3-parent" };
  return [
    event({
      eventId: "event-d3-1",
      producer: { seq: 1 },
      ids: baseIds,
      payload: { name: "D3 workflow", background: false, phaseCount: 2 },
    }),
    event({
      eventId: "event-d3-2",
      producer: { seq: 2 },
      kind: "workflow.phase",
      ids: baseIds,
      payload: { phase: "implementation" },
    }),
    event({
      eventId: "event-d3-3",
      producer: { seq: 3 },
      kind: "agent.created",
      ids: { ...baseIds, agentId, turnId: "turn_d3-1" },
      payload: {
        displayId: "sa-7",
        workflowAgentIndex: 0,
        origin: "workflow",
        backend: "claude",
        title: "security review <img src=x onerror=alert(1)>",
        resumed: false,
      },
    }),
    event({
      eventId: "event-d3-4",
      producer: { seq: 4 },
      kind: "agent.meta",
      ids: { ...baseIds, agentId, turnId: "turn_d3-1" },
      payload: {
        displayId: "sa-7",
        modelLabel: "claude-sonnet",
        update: "session",
      },
    }),
    event({
      eventId: "event-d3-5",
      producer: { seq: 5 },
      kind: "agent.message",
      ids: { ...baseIds, agentId, turnId: "turn_d3-1" },
      payload: { displayId: "sa-7", messageUnavailable: true },
    }),
    event({
      eventId: "event-d3-6",
      producer: { seq: 6 },
      kind: "agent.settled",
      ids: { ...baseIds, agentId, turnId: "turn_d3-1" },
      payload: {
        status: "done",
        outcome: "completed",
        finalPreview: "bounded result preview",
      },
    }),
    event({
      eventId: "event-d3-7",
      producer: { seq: 7 },
      kind: "workflow.settled",
      ids: baseIds,
      payload: { status: "completed" },
    }),
  ];
}

async function inProcessDaemon(t) {
  const paths = homePaths(tempAgentDir(t));
  ensureCompanionTree(paths);
  const opened = openDatabase(paths.database);
  const metrics = createMetrics(paths.metrics);
  const health = { ready: true, degraded: false };
  const daemon = {
    paths,
    state: { port: 0 },
    token: "i".repeat(43),
    readToken: "r".repeat(43),
    db: opened.db,
  };
  const server = await startHttpServer({
    db: opened.db,
    statements: createStatements(opened.db),
    readStatements: createReadStatements(opened.db),
    ingestToken: daemon.token,
    readToken: daemon.readToken,
    staticAssets: loadStaticAssets(),
    sizeSnapshot: createSizeSnapshot(paths),
    metrics,
    logger: createLogger(paths.log),
    health,
    config: createConfigLoader(paths.config),
    startedAt: Date.now(),
    idleMs: 60_000,
    nextReceivedAt: () => Date.now(),
    onIdle: () => {},
  });
  daemon.state.port = server.port;
  t.after(async () => {
    await server.close();
    opened.db.close();
  });
  return daemon;
}

async function seededDaemon(t, options = {}) {
  const daemon = options.inProcess
    ? await inProcessDaemon(t)
    : await startDaemon(t, tempAgentDir(t));
  const response = await ingest(daemon, seededEvents());
  assert.equal(response.status, 200);
  assert.equal(response.json.accepted, 7);
  return daemon;
}

test("read and ingest bearer scopes are disjoint and auth precedes route parsing", async (t) => {
  const daemon = await seededDaemon(t);
  for (const path of [
    "/v1/status",
    "/v1/runs?unknown=secret",
    "/v1/runs/x/events?afterSeq=broken",
    "/v1/does-not-exist",
  ]) {
    const missing = await readRequest(daemon, path, { token: "" });
    assert.equal(missing.status, 401, path);
    assert.deepEqual(missing.json, { error: "unauthorized" });
    const ingestScope = await readRequest(daemon, path, {
      token: daemon.token,
    });
    assert.equal(ingestScope.status, 401, path);
  }
  for (const [label, authorization] of [
    ["missing-prefix", daemon.readToken],
    ["lowercase-scheme", `bearer ${daemon.readToken}`],
    ["extra-space", `Bearer  ${daemon.readToken}`],
    ["too-long", `Bearer ${daemon.readToken}x`],
    ["empty", "Bearer "],
  ]) {
    const malformed = await readRequest(daemon, "/v1/status", {
      headers: { Authorization: authorization },
    });
    assert.equal(malformed.status, 401, label);
  }
  const alternateChannel = await readRequest(
    daemon,
    `/v1/status?token=${daemon.readToken}`,
    {
      token: "",
      headers: { Cookie: `read=${daemon.readToken}` },
    },
  );
  assert.equal(alternateChannel.status, 401);

  const wrongWriteScope = await ingest(daemon, [], {
    headers: { Authorization: `Bearer ${daemon.readToken}` },
  });
  assert.equal(wrongWriteScope.status, 401);
  const unknown = await readRequest(daemon, "/v1/does-not-exist");
  assert.equal(unknown.status, 404);
});

test("status, runs, run detail, agent detail, and scoped cursors expose bounded projections", async (t) => {
  const daemon = await seededDaemon(t);
  const status = await readRequest(daemon, "/v1/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.currentSeq, 7);
  assert.equal(status.json.minRetainedSeq, 1);
  assert.equal(status.json.eventCount, 7);
  assert.equal(status.json.runCount, 1);
  assert.equal(status.json.agentCount, 1);
  assert.equal(status.json.policy.defaultContentMode, "metadata");
  assert.equal(status.text.includes(daemon.readToken), false);

  const runs = await readRequest(
    daemon,
    "/v1/runs?status=completed&kind=workflow&limit=1",
  );
  assert.equal(runs.status, 200);
  assert.equal(runs.json.runs.length, 1);
  assert.equal(runs.json.runs[0].runId, "wf_d3abcdef");
  assert.deepEqual(runs.json.runs[0].agentCounts, {
    total: 1,
    running: 0,
    done: 1,
    error: 0,
    unknown: 0,
  });
  assert.equal(runs.json.nextCursor, null);

  const run = await readRequest(daemon, "/v1/runs/wf_d3abcdef");
  assert.equal(run.status, 200);
  assert.equal(run.json.agents.length, 1);
  assert.equal(run.json.agents[0].backend, "claude");
  assert.equal(run.json.agents[0].title, null);
  assert.equal(run.json.agents[0].metadata.incomplete, false);

  const firstPage = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=0&limit=2",
  );
  assert.deepEqual(
    firstPage.json.events.map((entry) => entry.seq),
    [1, 2],
  );
  assert.equal(firstPage.json.nextAfterSeq, 2);
  assert.equal(firstPage.json.hasMore, true);
  assert.equal(firstPage.json.currentSeq, 7);
  assert.equal(firstPage.json.events[0].capture.contentMode, "metadata");

  const secondPage = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=2&limit=500",
  );
  assert.deepEqual(
    secondPage.json.events.map((entry) => entry.seq),
    [3, 4, 5, 6, 7],
  );
  assert.equal(secondPage.json.hasMore, false);
  assert.equal(secondPage.json.nextAfterSeq, 7);

  const agent = await readRequest(daemon, "/v1/agents/agent_d3-opaque");
  assert.equal(agent.status, 200);
  assert.equal(agent.json.agent.runId, "wf_d3abcdef");
  assert.equal(agent.json.run.runKind, "workflow");
  const agentEvents = await readRequest(
    daemon,
    "/v1/agents/agent_d3-opaque/events?limit=500",
  );
  assert.deepEqual(
    agentEvents.json.events.map((entry) => entry.seq),
    [3, 4, 5, 6],
  );
  assert.equal(agentEvents.json.nextAfterSeq, 6);

  const beyondHighWater = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=1009&limit=10",
  );
  assert.equal(beyondHighWater.status, 200);
  assert.deepEqual(beyondHighWater.json.events, []);
  assert.equal(beyondHighWater.json.currentSeq, 7);
  assert.equal(beyondHighWater.json.nextAfterSeq, 1009);
});

test("newly served metadata redacts provider tokens, account keys, and 64-hex values", async (t) => {
  const daemon = await inProcessDaemon(t);
  const secrets = {
    stripe: "sk_live_51Nabcdefghijklmnopqrstuv",
    google: "AIzaSyD-abcdefghijklmnopqrstuvwxyz123456_",
    gitlab: "glpat-abcdefghijklmnopqrstuvwxyz123_",
    accountKey: "QWNjb3VudEtleVNlY3JldFZhbHVlMTIzNDU2Nzg5MA==",
    hex64: "0123456789abcdef".repeat(4),
  };
  const runId = "wf_d3-secrets";
  const agentId = "agent_d3-secrets";
  const accepted = await ingest(daemon, [
    event({
      eventId: "event-d3-secret-run",
      producer: { seq: 1 },
      ids: { runId },
      payload: { name: secrets.stripe },
    }),
    event({
      eventId: "event-d3-secret-agent",
      producer: { seq: 2 },
      kind: "agent.created",
      ids: { runId, agentId },
      payload: {
        displayId: secrets.google,
        origin: "model",
        backend: "pi",
        role: secrets.gitlab,
        title: secrets.hex64,
        nativeSessionId: `AccountKey=${secrets.accountKey}`,
      },
    }),
    event({
      eventId: "event-d3-secret-meta",
      producer: { seq: 3 },
      kind: "agent.meta",
      ids: { runId, agentId },
      payload: {
        displayId: secrets.google,
        modelLabel: `AccountKey=${secrets.accountKey}`,
      },
    }),
  ]);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.accepted, 3);

  const responses = await Promise.all([
    readRequest(daemon, "/v1/runs?limit=50"),
    readRequest(daemon, `/v1/runs/${runId}`),
    readRequest(daemon, `/v1/agents/${agentId}`),
    readRequest(daemon, `/v1/runs/${runId}/events?limit=50`),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    for (const secret of Object.values(secrets)) {
      assert.equal(response.text.includes(secret), false, secret);
    }
  }
  assert.match(responses.map((response) => response.text).join(""), /REDACTED/);

  const storedRows = [
    ...daemon.db.prepare("SELECT * FROM events").all(),
    ...daemon.db.prepare("SELECT * FROM runs").all(),
    ...daemon.db.prepare("SELECT * FROM agents").all(),
  ];
  const stored = JSON.stringify(storedRows);
  for (const secret of Object.values(secrets)) {
    assert.equal(stored.includes(secret), false, secret);
  }
});

test("strict filters, cursors, opaque SQL values, and deterministic keyset pagination fail closed", async (t) => {
  const daemon = await seededDaemon(t);
  for (const path of [
    "/v1/runs?unknown=1",
    "/v1/runs?limit=1&limit=2",
    "/v1/runs?limit=0",
    "/v1/runs?limit=-1",
    "/v1/runs?limit=1e9",
    "/v1/runs?status=done",
    "/v1/runs?kind=agent",
    "/v1/runs?projectId=%E0%A4",
    "/v1/runs?beforeSeq=7",
    "/v1/runs?beforeRunId=x",
    "/v1/runs/wf_d3abcdef/events?afterSeq=-1",
    "/v1/runs/wf_d3abcdef/events?afterSeq=1.5",
    "/v1/runs/wf_d3abcdef/events?afterSeq=abc",
  ]) {
    const response = await readRequest(daemon, path);
    assert.equal(response.status, 400, path);
    assert.match(response.json.error, /invalid|incomplete/);
  }

  const injection = "x'; DROP TABLE events; --";
  const boundProject = await readRequest(
    daemon,
    `/v1/runs?projectId=${encodeURIComponent(injection)}`,
  );
  assert.equal(boundProject.status, 200);
  assert.deepEqual(boundProject.json.runs, []);
  const boundRun = await readRequest(
    daemon,
    `/v1/runs/${encodeURIComponent(injection)}`,
  );
  assert.equal(boundRun.status, 404);

  const db = new DatabaseSync(daemon.paths.database, { readOnly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM events").get().value,
    7,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM runs").get().value, 1);
  db.close();
});

test("retention floor returns 410 for stale supplied cursors and preserves monotone high-water", async (t) => {
  const daemon = await seededDaemon(t, { inProcess: true });
  daemon.db.exec("DELETE FROM events WHERE seq <= 2");

  const stale = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=0",
  );
  assert.equal(stale.status, 410);
  assert.deepEqual(stale.json, {
    error: "cursor-pruned",
    currentSeq: 7,
    minRetainedSeq: 3,
  });
  const fresh = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?limit=500",
  );
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.events[0].seq, 3);

  daemon.db.exec("DELETE FROM events");
  const status = await readRequest(daemon, "/v1/status");
  assert.equal(status.json.currentSeq, 7);
  assert.equal(status.json.minRetainedSeq, 8);
  const empty = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?limit=10",
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.events, []);
  assert.equal(empty.json.nextAfterSeq, 7);
});

test("out-of-range stored integers degrade and unexpected read failures stay stable without degrading storage health", async (t) => {
  const daemon = await seededDaemon(t, { inProcess: true });
  daemon.db
    .prepare("UPDATE runs SET started_at_ms = ? WHERE run_id = ?")
    .run(9223372036854775807n, "wf_d3abcdef");

  const list = await readRequest(daemon, "/v1/runs?limit=50");
  const detail = await readRequest(daemon, "/v1/runs/wf_d3abcdef");
  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(list.json.runs[0].startedAtMs, null);
  assert.equal(detail.json.run.startedAtMs, null);
  assert.equal(list.text.includes("ERR_OUT_OF_RANGE"), false);
  assert.equal(detail.text.includes("ERR_OUT_OF_RANGE"), false);

  daemon.db.exec("DROP TABLE events");
  const failedRead = await readRequest(daemon, "/v1/status");
  assert.equal(failedRead.status, 500);
  assert.deepEqual(failedRead.json, { error: "internal-error" });
  assert.equal(failedRead.text.includes("SQLITE"), false);
  const health = await request(daemon.state, {
    headers: { Host: `127.0.0.1:${daemon.state.port}` },
  });
  assert.equal(health.status, 200);
  assert.equal(health.json.degraded, false);
});

test("event pages enforce a stored-byte budget and malformed stored JSON is unavailable, never raw", async (t) => {
  const daemon = await seededDaemon(t, { inProcess: true });
  const large = JSON.stringify({
    payload: { excerpt: "x".repeat(400_000) },
    capture: { contentMode: "metadata", truncated: true },
  });
  const update = daemon.db.prepare(
    "UPDATE events SET payload_json = ? WHERE seq = ?",
  );
  for (const seq of [1, 2, 3, 4]) update.run(large, seq);

  const bounded = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=0&limit=500",
  );
  assert.equal(bounded.status, 200);
  assert.ok(bounded.json.events.length >= 1);
  assert.ok(bounded.json.events.length < 4);
  assert.equal(bounded.json.hasMore, true);
  assert.ok(Buffer.byteLength(bounded.text) < 4 * 1024 * 1024);

  const eventCanary = "OVERSIZED-EVENT-RAW-CANARY";
  const oversizedEvent = JSON.stringify({
    payload: { excerpt: eventCanary.repeat(220_000) },
    capture: { contentMode: "metadata", truncated: true },
  });
  update.run(oversizedEvent, 2);
  const poisonedFirst = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=1&limit=1",
  );
  assert.equal(poisonedFirst.status, 200);
  assert.equal(poisonedFirst.text.includes(eventCanary), false);
  assert.equal(poisonedFirst.json.events[0].seq, 2);
  assert.equal(poisonedFirst.json.events[0].payload, null);
  assert.equal(poisonedFirst.json.events[0].capture.unavailable, true);
  assert.equal(poisonedFirst.json.nextAfterSeq, 2);
  assert.equal(poisonedFirst.json.hasMore, true);
  const advanced = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=2&limit=1",
  );
  assert.equal(advanced.status, 200);
  assert.equal(advanced.json.events[0].seq, 3);

  const runCanary = "OVERSIZED-RUN-RAW-CANARY";
  daemon.db
    .prepare("UPDATE runs SET metadata_json = ? WHERE run_id = ?")
    .run(JSON.stringify({ value: runCanary.repeat(220_000) }), "wf_d3abcdef");
  const poisonedList = await readRequest(daemon, "/v1/runs?limit=50");
  const poisonedDetail = await readRequest(daemon, "/v1/runs/wf_d3abcdef");
  for (const response of [poisonedList, poisonedDetail]) {
    assert.equal(response.status, 200);
    assert.equal(response.text.includes(runCanary), false);
  }
  assert.equal(poisonedList.json.runs[0].metadata, null);
  assert.equal(poisonedDetail.json.run.metadata, null);

  daemon.db.exec("PRAGMA ignore_check_constraints = ON");
  daemon.db
    .prepare("UPDATE events SET payload_json = ? WHERE seq = 5")
    .run("not-json-RAW-CANARY");
  daemon.db
    .prepare("UPDATE events SET redaction_json = ? WHERE seq = 6")
    .run("also-not-json-RAW-CANARY");
  const malformed = await readRequest(
    daemon,
    "/v1/runs/wf_d3abcdef/events?afterSeq=4&limit=10",
  );
  assert.equal(malformed.status, 200);
  assert.equal(malformed.text.includes("RAW-CANARY"), false);
  assert.equal(malformed.json.events[0].payload, null);
  assert.equal(malformed.json.events[0].capture.unavailable, true);
  assert.equal(malformed.json.events[1].redaction, null);
  assert.equal(malformed.json.events[1].capture.unavailable, true);
});

test("event responses raise a pre-query watermark to the greatest returned sequence", () => {
  const eventRow = {
    seq: 10,
    event_id: "event-raced-watermark",
    event_kind: "workflow.phase",
    schema_version: 1,
    producer_id: "producer-raced-watermark",
    producer_seq: 10,
    producer_kind: "pi",
    occurred_at_ms: 1_000,
    received_at_ms: 1_001,
    trace_id: null,
    run_id: "wf_raced-watermark",
    parent_run_id: null,
    agent_id: null,
    turn_id: null,
    tool_call_id: null,
    project_id: null,
    payload_json: JSON.stringify({
      payload: { phase: "race" },
      capture: { contentMode: "metadata", truncated: false },
    }),
    redaction_json: JSON.stringify({ counts: {} }),
  };
  const value = (entry) => ({ get: () => ({ value: entry }) });
  const route = createReadRouter({
    statements: {
      maxRetainedSeq: value(9),
      minRetainedSeq: value(1),
      eventHighWater: value(9),
      runEvents: { all: () => [eventRow] },
      agentEvents: { all: () => [] },
    },
  });
  const response = route({
    method: "GET",
    url: "/v1/runs/wf_raced-watermark/events?afterSeq=9&limit=10",
  });
  assert.equal(response.events[0].seq, 10);
  assert.equal(response.currentSeq, 10);
  assert.equal(response.nextAfterSeq, 10);
});

test("accepted sequence queries use the existing partial indexes", async (t) => {
  const daemon = await seededDaemon(t);
  const db = new DatabaseSync(daemon.paths.database, { readOnly: true });
  const explain = (sql, ...values) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...values)
      .map((row) => row.detail)
      .join("\n");
  assert.match(
    explain(
      "SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      "wf_d3abcdef",
      0,
      10,
    ),
    /events_run_seq/,
  );
  assert.match(
    explain(
      "SELECT * FROM events WHERE agent_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      "agent_d3-opaque",
      0,
      10,
    ),
    /events_agent_seq/,
  );
  assert.match(
    explain(
      "SELECT * FROM agents WHERE run_id = ? ORDER BY started_at_ms ASC, agent_id ASC LIMIT ?",
      "wf_d3abcdef",
      10,
    ),
    /agents_run_started/,
  );
  db.close();
});
