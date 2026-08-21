import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "../src/db/open.mjs";
import { createStatements } from "../src/db/statements.mjs";
import { ensureCompanionTree } from "../src/fsguard.mjs";
import { homePaths } from "../src/home.mjs";
import { normalizeEvent } from "../src/ingest/normalize.mjs";
import { classifySqliteError, receiveBatch } from "../src/ingest/receive.mjs";
import { rebuildProjections } from "../src/project/rebuild.mjs";
import { event, tempAgentDir } from "./helpers.mjs";

function database(t) {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const opened = openDatabase(paths.database);
  t.after(() => {
    try {
      opened.db.close();
    } catch {
      // A test may already close it.
    }
  });
  return opened.db;
}

function sequenced(seq, overrides = {}) {
  return event({
    eventId: `opaque-event-${seq}`,
    producer: { seq },
    occurredAt: 10_000 - seq * 100,
    ...overrides,
  });
}

test("structural depth, key, ID, and non-content envelope bounds fail before persistence", (t) => {
  let nested = {};
  for (let index = 0; index < 40; index++) nested = { child: nested };
  assert.throws(
    () => normalizeEvent(event({ payload: nested })),
    (error) => error.code === "depth-limit",
  );
  assert.throws(
    () =>
      normalizeEvent(
        event({
          payload: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`k${index}`, index]),
          ),
        }),
      ),
    (error) => error.code === "object-key-limit",
  );
  assert.throws(
    () => normalizeEvent(event({ eventId: "x".repeat(201) })),
    (error) => error.code === "invalid-event-id",
  );
  for (const eventId of ["event_\ud800", "event_\ud801"]) {
    assert.throws(
      () => normalizeEvent(event({ eventId })),
      (error) => error.code === "invalid-unicode",
    );
  }
  assert.throws(
    () => normalizeEvent(event({ payload: { text: "bad\udfff" } })),
    (error) => error.code === "invalid-unicode",
  );

  const db = database(t);
  const rejected = receiveBatch(db, [event({ payload: nested })], 1_000);
  assert.equal(rejected.results[0].status, "rejected");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
});

test("normalization re-redacts every nested string, recomputes project ID, and stores coarse telemetry", () => {
  const normalized = normalizeEvent(
    event({
      kind: "future.adapter.kind",
      eventId: "artifact-sha256-opaque",
      payload: {
        nested: {
          password: "distinct-password-value",
          line: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
        },
      },
    }),
  );
  assert.equal(normalized.eventId, "artifact-sha256-opaque");
  assert.equal(
    normalized.payloadJson.includes("distinct-password-value"),
    false,
  );
  assert.equal(
    normalized.payloadJson.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"),
    false,
  );
  assert.match(normalized.payloadJson, /REDACTED/);
  assert.equal(normalized.projectId.startsWith("sha256:"), true);
  assert.equal(normalized.projectIdMismatch, true);
  const telemetry = JSON.parse(normalized.redactionJson);
  assert.equal(Object.values(telemetry.counts).every(Number.isInteger), true);
  assert.equal(normalized.redactionJson.includes("distinct-password"), false);
});

test("content is redacted, UTF-8 bounded, aggregate-truncated, and re-scanned", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const huge = `${"😀".repeat(80_000)}${secret}`;
  const normalized = normalizeEvent(
    event({
      kind: "future.large.kind",
      payload: { first: huge, second: huge, third: huge },
    }),
  );
  const stored = JSON.parse(normalized.payloadJson);
  assert.equal(normalized.truncated, true);
  assert.ok(stored.capture.daemonTruncation.truncatedFields.length >= 2);
  assert.equal(normalized.payloadJson.includes(secret), false);
  assert.equal(normalized.payloadJson.includes("�"), false);
  assert.ok(Buffer.byteLength(normalized.payloadJson) < 512 * 1024);
  const totalStored = Object.values(
    stored.capture.daemonTruncation.fieldBytes,
  ).reduce((sum, value) => sum + value.stored, 0);
  assert.ok(totalStored <= 256 * 1024);
});

test("a redaction marker crossing a truncation boundary remains complete", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const normalized = normalizeEvent(
    event({
      kind: "workflow.log",
      payload: { message: `${"x".repeat(70 * 1024)} ${secret}` },
    }),
  );
  const message = JSON.parse(normalized.payloadJson).payload.message;
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes("[REDACTED:token]"), true);
  assert.equal(message.includes("[REDACTED:token"), true);
  assert.equal(JSON.parse(normalized.payloadJson).capture.truncated, true);
});

test("producer truncation provenance is preserved separately from daemon truncation", () => {
  const normalized = normalizeEvent(
    event({
      kind: "workflow.log",
      payload: { message: "already producer-truncated" },
      capture: {
        contentMode: "rich",
        truncated: true,
        truncatedFields: ["payload.message"],
        fieldBytes: {
          "payload.message": { original: 9000, stored: 28 },
        },
      },
    }),
  );
  const capture = JSON.parse(normalized.payloadJson).capture;
  assert.equal(capture.truncated, true);
  assert.deepEqual(capture.producerTruncation, {
    fieldBytes: {
      "payload.message": { original: 9000, stored: 28 },
    },
    truncated: true,
    truncatedFields: ["payload.message"],
  });
  assert.equal(capture.daemonTruncation, undefined);
  assert.equal(normalized.truncated, true);
});

test("metadata content mode omits rich unknown content without dropping the event", () => {
  const normalized = normalizeEvent(
    event({
      kind: "future.unknown",
      capture: { contentMode: "metadata" },
      payload: { secret: "must-not-be-stored", ordinary: "also-content" },
    }),
  );
  const stored = JSON.parse(normalized.payloadJson);
  assert.equal(stored.payload.secret, undefined);
  assert.equal(stored.payload.ordinary, undefined);
  assert.equal(stored.payload.background, false);
  assert.equal(stored.capture.truncated, true);
});

test("receive order assigns daemon seq and producer time cannot gate projections", (t) => {
  const db = database(t);
  const first = sequenced(1, {
    kind: "workflow.started",
    occurredAt: 9_999,
    payload: { name: "first" },
  });
  const second = sequenced(2, {
    kind: "workflow.phase",
    occurredAt: 1,
    payload: { phase: "latest receive" },
  });
  const result = receiveBatch(db, [first, second], 1_000);
  assert.deepEqual(
    result.results.map((entry) => entry.seq),
    [1, 2],
  );
  const run = db.prepare("SELECT * FROM runs").get();
  assert.equal(run.current_phase, "latest receive");
  assert.equal(run.last_seq, 2);
});

test("same hash replay is idempotent and conflicting IDs retain the original", (t) => {
  const db = database(t);
  const original = sequenced(1, { payload: { name: "original" } });
  const accepted = receiveBatch(db, [original], 1_000);
  const duplicate = receiveBatch(db, [structuredClone(original)], 2_000);
  assert.equal(accepted.results[0].status, "accepted");
  assert.deepEqual(duplicate.results[0], {
    eventId: original.eventId,
    status: "duplicate",
    seq: 1,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    1,
  );
  assert.equal(db.prepare("SELECT last_seq FROM runs").get().last_seq, 1);

  const conflict = receiveBatch(
    db,
    [{ ...original, payload: { name: "changed" } }],
    3_000,
  );
  assert.equal(conflict.results[0].status, "conflict");
  assert.equal(
    JSON.parse(db.prepare("SELECT payload_json FROM events").get().payload_json)
      .payload.name,
    "original",
  );

  const producerConflict = receiveBatch(
    db,
    [
      {
        ...original,
        eventId: "different-event-id",
        payload: { name: "different" },
      },
    ],
    4_000,
  );
  assert.equal(
    producerConflict.results[0].reason,
    "producer-sequence-conflict",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    1,
  );
});

test("idempotency fingerprints the complete normalized stored event", (t) => {
  const db = database(t);
  const original = sequenced(1, { payload: { name: "same" } });
  receiveBatch(db, [original], 1_000);

  const changedEnvelope = receiveBatch(
    db,
    [
      {
        ...original,
        kind: "workflow.settled",
        occurredAt: 999,
        ids: {
          ...original.ids,
          traceId: "trace_other",
          runId: "wf_other",
        },
        producer: { id: "producer_other", seq: 7, kind: "other" },
      },
    ],
    2_000,
  );
  assert.equal(changedEnvelope.results[0].status, "conflict");
  assert.equal(changedEnvelope.results[0].reason, "event-id-conflict");
  assert.equal(
    Object.hasOwn(changedEnvelope.highestAckedProducerSeq, "producer_other"),
    false,
  );

  const changedEventId = receiveBatch(
    db,
    [{ ...original, eventId: "different-event-id" }],
    3_000,
  );
  assert.equal(changedEventId.results[0].status, "conflict");
  assert.equal(changedEventId.results[0].reason, "producer-sequence-conflict");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    1,
  );
});

test("one conflict does not abort later valid events in the batch", (t) => {
  const db = database(t);
  const first = sequenced(1);
  receiveBatch(db, [first], 1_000);
  const result = receiveBatch(
    db,
    [
      { ...first, payload: { name: "conflict" } },
      sequenced(2, { kind: "workflow.phase", payload: { phase: "accepted" } }),
    ],
    2_000,
  );
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["conflict", "accepted"],
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    2,
  );
  assert.equal(
    db.prepare("SELECT current_phase FROM runs").get().current_phase,
    "accepted",
  );
});

test("faults before and after projection roll back event and projection together", (t) => {
  const db = database(t);
  assert.throws(
    () => receiveBatch(db, [sequenced(1)], 1_000, { faultAfterEventInsert: 0 }),
    /injected-after-event-insert/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 0);
  assert.throws(
    () =>
      receiveBatch(db, [sequenced(1)], 1_500, {
        faultAfterProjection: 0,
      }),
    /injected-after-projection/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 0);
  const retry = receiveBatch(db, [sequenced(1)], 2_000);
  assert.equal(retry.results[0].seq, 1);
});

test("numeric SQLite errors classify unique conflicts and unavailable storage", (t) => {
  assert.equal(classifySqliteError({ errcode: 2067 }), "unique-constraint");
  assert.equal(classifySqliteError({ errcode: 1555 }), "unique-constraint");
  for (const errcode of [5, 6, 10, 13, 14]) {
    assert.equal(classifySqliteError({ errcode }), "storage-unavailable");
  }
  assert.equal(classifySqliteError({ errcode: 1811 }), "other");

  const db = database(t);
  const statements = createStatements(db);
  const result = receiveBatch(db, [sequenced(1)], 1_000, {
    statements: {
      ...statements,
      insertEvent: {
        run() {
          throw Object.assign(new Error("constraint failed"), {
            errcode: 2067,
          });
        },
      },
    },
  });
  assert.equal(result.results[0].status, "conflict");
  assert.equal(result.results[0].reason, "constraint-conflict");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
});

test("SQLITE_BUSY at transaction start becomes a retryable storage error", (t) => {
  const db = database(t);
  const file = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main").file;
  const blocker = new DatabaseSync(file);
  blocker.exec("PRAGMA busy_timeout=1; BEGIN IMMEDIATE");
  db.exec("PRAGMA busy_timeout=1");
  try {
    assert.throws(
      () => receiveBatch(db, [sequenced(1)], 1_000),
      (error) => error.code === "storage-unavailable" && error.status === 503,
    );
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
});

test("SQLITE_FULL aborts the batch with a 503-class storage error and no partial rows", (t) => {
  const db = database(t);
  const pages = db.prepare("PRAGMA page_count").get().page_count;
  db.prepare(`PRAGMA max_page_count = ${pages}`).get();
  assert.throws(
    () =>
      receiveBatch(
        db,
        [
          sequenced(1, {
            kind: "future.large.kind",
            payload: { text: "x".repeat(200_000) },
          }),
        ],
        1_000,
      ),
    (error) => error.code === "storage-unavailable" && error.status === 503,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 0);
});

test("incomplete agent/run rows never persist last_seq zero and authoritative creation fills them", (t) => {
  const db = database(t);
  const ids = {
    runId: "sa_opaque-run",
    agentId: "agent_opaque",
    turnId: "turn_one",
  };
  receiveBatch(
    db,
    [
      sequenced(1, {
        kind: "agent.tool_finished",
        ids,
        payload: {
          displayId: "sa-1",
          name: "read",
          isError: false,
          resultUnavailable: true,
        },
      }),
    ],
    1_000,
  );
  let run = db.prepare("SELECT * FROM runs").get();
  let agent = db.prepare("SELECT * FROM agents").get();
  assert.equal(run.last_seq, 1);
  assert.equal(agent.last_seq, 1);
  assert.equal(JSON.parse(run.metadata_json).incomplete, true);
  assert.equal(JSON.parse(agent.metadata_json).incomplete, true);

  receiveBatch(
    db,
    [
      sequenced(2, {
        kind: "agent.created",
        ids,
        payload: {
          origin: "model",
          backend: "pi",
          title: "worker",
          resumed: false,
        },
      }),
    ],
    2_000,
  );
  run = db.prepare("SELECT * FROM runs").get();
  agent = db.prepare("SELECT * FROM agents").get();
  assert.equal(run.run_kind, "standalone");
  assert.equal(run.status, "running");
  assert.equal(JSON.parse(run.metadata_json).incomplete, false);
  assert.equal(JSON.parse(agent.metadata_json).incomplete, false);
});

test("terminal agent returns to running only for distinct authoritative turn ID", (t) => {
  const db = database(t);
  const ids = {
    runId: "sa_turn-run",
    agentId: "agent_turn",
    turnId: "turn_one",
  };
  receiveBatch(
    db,
    [
      sequenced(1, {
        kind: "agent.created",
        ids,
        payload: { origin: "model", backend: "pi", title: "worker" },
      }),
      sequenced(2, {
        kind: "agent.settled",
        ids,
        payload: { status: "done", outcome: "completed" },
      }),
      sequenced(3, {
        kind: "agent.run_started",
        ids,
        payload: { displayId: "sa-1", backend: "pi", turnNumber: 1 },
      }),
    ],
    1_000,
  );
  assert.equal(db.prepare("SELECT status FROM agents").get().status, "done");
  assert.equal(db.prepare("SELECT status FROM runs").get().status, "completed");
  receiveBatch(
    db,
    [
      sequenced(4, {
        kind: "agent.run_started",
        ids: { ...ids, turnId: "turn_two" },
        payload: { displayId: "sa-1", backend: "pi", turnNumber: 2 },
      }),
    ],
    2_000,
  );
  const agent = db.prepare("SELECT status, current_turn_id FROM agents").get();
  assert.deepEqual(
    { ...agent },
    { status: "running", current_turn_id: "turn_two" },
  );
  assert.equal(db.prepare("SELECT status FROM runs").get().status, "running");
});

test("agent meta and usage projections retain only bounded summary fields", (t) => {
  const db = database(t);
  const ids = {
    runId: "sa_metadata-run",
    agentId: "agent_metadata",
    turnId: "turn_metadata",
  };
  receiveBatch(
    db,
    [
      sequenced(1, {
        kind: "agent.created",
        ids,
        payload: { origin: "model", backend: "pi", title: "worker" },
      }),
      sequenced(2, {
        kind: "agent.meta",
        ids,
        payload: {
          displayId: "sa-1",
          update: "session",
          modelLabel: "model",
          contextWindow: 200_000,
          additiveBlob: "x".repeat(200_000),
        },
      }),
      sequenced(3, {
        kind: "agent.usage",
        ids,
        payload: {
          displayId: "sa-1",
          tokens: 100,
          costUsd: 0.1,
          additiveBlob: "y".repeat(200_000),
        },
      }),
    ],
    1_000,
  );
  const metadataText = db
    .prepare("SELECT metadata_json FROM agents")
    .get().metadata_json;
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.meta.additiveBlob, undefined);
  assert.equal(metadata.usage.additiveBlob, undefined);
  assert.equal(metadata.meta.contextWindow, 200_000);
  assert.equal(metadata.usage.tokens, 100);
  assert.ok(Buffer.byteLength(metadataText) < 16 * 1024);
  assert.equal(rebuildProjections(db, { check: true }).equal, true);
});

test("unknown, telemetry, and artifact kinds store safely without projection", (t) => {
  const db = database(t);
  const result = receiveBatch(
    db,
    [
      sequenced(1, { kind: "unknown.kind" }),
      sequenced(2, { kind: "telemetry.dropped" }),
      sequenced(3, { kind: "artifact.recovered" }),
    ],
    1_000,
  );
  assert.equal(result.accepted, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    3,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 0);
});

test("projection rebuild is byte-stable and check mode reports drift without writing", (t) => {
  const db = database(t);
  receiveBatch(
    db,
    [
      sequenced(1),
      sequenced(2, { kind: "workflow.phase", payload: { phase: "review" } }),
      sequenced(3, {
        kind: "workflow.settled",
        payload: { status: "completed" },
      }),
    ],
    1_000,
  );
  const clean = rebuildProjections(db, { check: true });
  assert.equal(clean.equal, true);
  db.prepare("UPDATE runs SET name = 'drifted'").run();
  const checked = rebuildProjections(db, { check: true });
  assert.equal(checked.changed, true);
  assert.equal(db.prepare("SELECT name FROM runs").get().name, "drifted");
  const rebuilt = rebuildProjections(db);
  assert.equal(rebuilt.changed, true);
  assert.equal(db.prepare("SELECT name FROM runs").get().name, "test workflow");
});

test("SQL metacharacters in opaque IDs are bound data and never alter schema", (t) => {
  const db = database(t);
  const injection = "x'; DROP TABLE events; --";
  const result = receiveBatch(
    db,
    [sequenced(1, { ids: { runId: injection }, payload: { name: injection } })],
    1_000,
  );
  assert.equal(result.accepted, 1);
  assert.equal(db.prepare("SELECT run_id FROM runs").get().run_id, injection);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    1,
  );
});
