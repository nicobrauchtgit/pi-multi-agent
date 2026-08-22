import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { normalizeProducerEnvelope } from "../../extensions/shared/observability/normalize.mjs";
import { ensureCompanionTree } from "../src/fsguard.mjs";
import { homePaths } from "../src/home.mjs";
import {
  daemonEntry,
  event,
  ingest,
  repositoryRoot,
  startDaemon,
  tempAgentDir,
} from "./helpers.mjs";

function writeConfig(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const now = new Date(Date.now() + 1_000);
  fs.utimesSync(file, now, now);
}

function storedEvent(database, eventId) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT payload_json, redaction_json, received_at_ms FROM events WHERE event_id = ?",
      )
      .get(eventId);
  } finally {
    db.close();
  }
}

test("protected config rejects symlinks before daemon startup", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const external = path.join(agentDir, "external-config.json");
  fs.writeFileSync(external, "{}\n", { mode: 0o600 });
  fs.symlinkSync(external, paths.config);
  const child = spawnSync(
    process.execPath,
    [daemonEntry, "start", "--agent-dir", agentDir],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(child.status, 71);
  assert.match(child.stderr, /symlink-rejected/);
});

test("daemon independently enforces metadata and disabled longest-root project policy", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const project = fs.mkdtempSync(path.join(agentDir, "project-"));
  const nested = path.join(project, "nested");
  fs.mkdirSync(nested);
  const base = {
    version: 1,
    capture: "rich",
    autostart: true,
    defaults: { enabled: true, contentMode: "metadata" },
    projects: [{ root: project, enabled: false }],
  };
  writeConfig(daemon.paths.config, base);

  const disabled = event({
    eventId: "event-disabled-project",
    project: { id: "untrusted", root: nested },
    kind: "message.user",
    payload: { content: "must never persist" },
    capture: { contentMode: "rich" },
  });
  const rejected = await ingest(daemon, [disabled]);
  assert.equal(rejected.status, 200);
  assert.deepEqual(rejected.json.results[0], {
    status: "rejected",
    reason: "project-disabled",
  });
  assert.equal(storedEvent(daemon.paths.database, disabled.eventId), undefined);

  writeConfig(daemon.paths.config, {
    ...base,
    projects: [
      { root: project, enabled: false },
      { root: nested, enabled: true, contentMode: "metadata" },
    ],
  });
  const metadata = event({
    eventId: "event-metadata-project",
    producer: { seq: 2 },
    project: { id: "untrusted", root: nested },
    kind: "message.user",
    payload: { content: "private but not scanner-shaped" },
    capture: { contentMode: "rich" },
  });
  const accepted = await ingest(daemon, [metadata]);
  assert.equal(accepted.json.results[0].status, "accepted");
  const stored = storedEvent(daemon.paths.database, metadata.eventId);
  assert.equal(
    stored.payload_json.includes("private but not scanner-shaped"),
    false,
  );
  const redaction = JSON.parse(stored.redaction_json);
  assert.equal(redaction.policy.contentMode, "metadata");
  assert.equal(redaction.policy.producerContentMode, "rich");
  assert.match(redaction.policy.policySource, /^daemon:/);
});

test("daemon fails closed for missing attribution and D2 rich configuration", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  writeConfig(daemon.paths.config, {
    version: 1,
    capture: "rich",
    defaults: { enabled: true, contentMode: "rich" },
  });

  const unattributed = event({
    eventId: "event-no-project-rich",
    project: null,
    kind: "message.user",
    payload: { content: "UNATTRIBUTED-CONTENT-MUST-NOT-PERSIST" },
    capture: { contentMode: "rich" },
  });
  const sentinelSecret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX";
  const oldSentinel = "\r\u0000redaction-json-boundary\u0000";
  const attributed = event({
    eventId: "event-attributed-rich-d2",
    producer: { seq: 2 },
    kind: "message.user",
    payload: {
      content: "RICH-CONFIG-CONTENT-MUST-NOT-PERSIST",
      modelLabel: `${oldSentinel}${oldSentinel}${sentinelSecret}${oldSentinel}`,
    },
    capture: { contentMode: "rich" },
  });
  const response = await ingest(daemon, [unattributed, attributed]);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.json.results.map((result) => result.status),
    ["accepted", "accepted"],
  );
  for (const [eventId, secret, source] of [
    [
      unattributed.eventId,
      "UNATTRIBUTED-CONTENT-MUST-NOT-PERSIST",
      "daemon:unattributed",
    ],
    [
      attributed.eventId,
      "RICH-CONFIG-CONTENT-MUST-NOT-PERSIST",
      "daemon:defaults",
    ],
  ]) {
    const stored = storedEvent(daemon.paths.database, eventId);
    assert.equal(stored.payload_json.includes(secret), false);
    const redaction = JSON.parse(stored.redaction_json);
    assert.equal(redaction.policy.contentMode, "metadata");
    assert.equal(redaction.policy.policySource, source);
    assert.equal(redaction.policy.daemonRichCaptureAllowed, false);
  }
  assert.equal(
    storedEvent(
      daemon.paths.database,
      attributed.eventId,
    ).payload_json.includes(sentinelSecret),
    false,
  );
});

test("received_at_ms is wall-clock display data while seq alone orders a batch", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const before = Date.now();
  const response = await ingest(daemon, [
    event({ eventId: "event-wall-clock-1", producer: { seq: 1 } }),
    event({ eventId: "event-wall-clock-2", producer: { seq: 2 } }),
  ]);
  const after = Date.now();
  assert.equal(response.status, 200);
  const db = new DatabaseSync(daemon.paths.database, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT seq, received_at_ms FROM events WHERE event_id LIKE 'event-wall-clock-%' ORDER BY seq",
    )
    .all();
  db.close();
  assert.deepEqual(
    rows.map((row) => row.seq),
    [1, 2],
  );
  assert.equal(rows[0].received_at_ms, rows[1].received_at_ms);
  assert.ok(
    rows[0].received_at_ms >= before && rows[0].received_at_ms <= after,
  );
});

test("daemon spool replay isolates malformed envelope versions and drains later segments", async (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  writeConfig(paths.config, {
    version: 1,
    capture: "metadata",
    defaults: { enabled: true, contentMode: "metadata" },
  });
  const producerId = "producer_00000000-0000-4000-8000-000000000088";
  const directory = path.join(paths.spoolDir, producerId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const valid = (eventId, seq) =>
    normalizeProducerEnvelope(
      event({
        eventId,
        producer: { id: producerId, seq },
        payload: { name: eventId, background: false, phaseCount: 0 },
        capture: { contentMode: "metadata" },
      }),
      { contentMode: "metadata" },
    ).serialized;
  fs.writeFileSync(
    path.join(directory, "00000001.ndjson"),
    `${valid("event-before-poison", 1)}\n${JSON.stringify({ v: 2 })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(directory, "00000002.ndjson"),
    `${valid("event-after-poison", 3)}\n`,
    { mode: 0o600 },
  );

  const daemon = await startDaemon(t, agentDir);
  assert.ok(storedEvent(paths.database, "event-before-poison"));
  assert.ok(storedEvent(paths.database, "event-after-poison"));
  assert.equal(fs.existsSync(path.join(directory, "00000001.ndjson")), false);
  assert.equal(fs.existsSync(path.join(directory, "00000002.ndjson")), false);
  const metrics = JSON.parse(fs.readFileSync(paths.metrics, "utf8"));
  assert.equal(metrics.spoolMalformed, 1);
  assert.equal(metrics.spoolSegmentsReplayed, 2);
  assert.equal(metrics.spoolRecordsReplayed, 2);
  assert.equal(metrics.producerGaps, 1);
});

test("daemon ignores fresh temps and segment symlinks without following", async (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const producerId = "producer_00000000-0000-4000-8000-000000000089";
  const directory = path.join(paths.spoolDir, producerId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const temporary = path.join(
    directory,
    ".00000001.ndjson.123.0000000000000000.tmp",
  );
  fs.writeFileSync(temporary, "incomplete", { mode: 0o600 });
  const target = path.join(paths.root, "outside-segment");
  fs.writeFileSync(target, "outside", { mode: 0o600 });
  const link = path.join(directory, "00000001.ndjson");
  fs.symlinkSync(target, link);

  await startDaemon(t, agentDir);
  assert.equal(fs.existsSync(temporary), true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), "outside");
  const metrics = JSON.parse(fs.readFileSync(paths.metrics, "utf8"));
  assert.equal(metrics.spoolMalformed, 0);
});

test("producer gap gauge closes when a late sequence arrives", async (t) => {
  const agentDir = tempAgentDir(t);
  const daemon = await startDaemon(t, agentDir);
  const producer = { id: "producer-gap-gauge", kind: "pi" };
  await ingest(daemon, [
    event({ eventId: "event-gap-1", producer: { ...producer, seq: 1 } }),
    event({ eventId: "event-gap-3", producer: { ...producer, seq: 3 } }),
  ]);
  let metrics = JSON.parse(fs.readFileSync(daemon.paths.metrics, "utf8"));
  assert.equal(metrics.producerGaps, 1);
  await ingest(daemon, [
    event({ eventId: "event-gap-2", producer: { ...producer, seq: 2 } }),
  ]);
  metrics = JSON.parse(fs.readFileSync(daemon.paths.metrics, "utf8"));
  assert.equal(metrics.producerGaps, 0);
  await daemon.stop();
  const restarted = await startDaemon(t, agentDir);
  metrics = JSON.parse(fs.readFileSync(restarted.paths.metrics, "utf8"));
  assert.equal(metrics.producerGaps, 0);
});

test("daemon adopts immutable foreign producer spool before live traffic", async (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  writeConfig(paths.config, {
    version: 1,
    capture: "metadata",
    defaults: { enabled: true, contentMode: "metadata" },
  });
  const producerId = "producer_00000000-0000-4000-8000-000000000099";
  const directory = path.join(paths.spoolDir, producerId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const normalized = normalizeProducerEnvelope(
    event({
      eventId: "event-adopted-spool",
      producer: { id: producerId, seq: 1 },
      payload: { name: "adopted", background: false, phaseCount: 0 },
      capture: { contentMode: "metadata" },
    }),
    { contentMode: "metadata" },
  );
  const segment = path.join(directory, "00000001.ndjson");
  fs.writeFileSync(segment, `${normalized.serialized}\n{"partial"`, {
    mode: 0o600,
  });

  const daemon = await startDaemon(t, agentDir);
  const stored = storedEvent(daemon.paths.database, "event-adopted-spool");
  assert.ok(stored);
  assert.equal(fs.existsSync(segment), false);
  const metrics = JSON.parse(fs.readFileSync(paths.metrics, "utf8"));
  assert.equal(metrics.spoolSegmentsReplayed, 1);
  assert.equal(metrics.spoolPartialTails, 1);
});
