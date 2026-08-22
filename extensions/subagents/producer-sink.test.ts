import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { bindChildSessionExtensions } from "../shared/child-session.ts";
import { observabilityPaths } from "../shared/observability/home.mjs";
import { normalizePolicyConfig } from "../shared/observability/policy.mjs";
import { buildC0Event } from "../shared/observability/events.ts";
import {
  mintEventId,
  mintProducerId,
  type ProducerId,
} from "../shared/observability/ids.ts";
import { normalizeProducerEnvelope } from "../shared/observability/normalize.mjs";
import { createDaemonController } from "./src/daemon-control.ts";
import {
  createProducerSink,
  currentProducerSink,
  resetProducerSinkForTests,
} from "./src/producer-sink.ts";
import {
  readStableProtectedFile,
  unlinkProtectedFile,
} from "./src/protected-fs.ts";
import { createProtectedSpool } from "./src/spool.ts";

function tempPaths(t: TestContext) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-producer-d2-"));
  fs.chmodSync(agentDir, 0o700);
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  return observabilityPaths(agentDir);
}

function config(mode: "metadata" | "rich" = "rich") {
  return normalizePolicyConfig({
    version: 1,
    capture: mode,
    autostart: false,
    defaults: {
      enabled: true,
      contentMode: mode,
      maxSpoolBytes: 64 * 1024 * 1024,
    },
  });
}

function pending(payload: Record<string, unknown>, kind = "workflow.log") {
  return {
    ...buildC0Event({
      kind: "workflow.log",
      ids: { runId: "wf_abcdef123456" },
      project: { id: "supplied", root: process.cwd() },
      payload: { message: "fixture" },
      capture: { contentMode: "rich", truncated: false },
    }),
    eventId: mintEventId(),
    kind,
    payload,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

function unavailableTransport() {
  return {
    async send() {
      throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    },
    close() {},
  };
}

test("duplicate module evaluation reuses one producer and child loads cannot create one", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const first = createProducerSink({
    paths,
    config: config("metadata"),
    transport: unavailableTransport(),
  });
  const duplicate = await import(
    new URL("./src/producer-sink.ts?duplicate=1", import.meta.url).href
  );
  const second = duplicate.createProducerSink({
    paths,
    config: config("metadata"),
    transport: unavailableTransport(),
  });
  assert.equal(second, first);
  let childError: unknown;
  await bindChildSessionExtensions({
    async bindExtensions() {
      try {
        duplicate.createProducerSink({
          paths,
          config: config("metadata"),
          transport: unavailableTransport(),
        });
      } catch (error) {
        childError = error;
      }
    },
  });
  assert.match(String(childError), /child extension load/i);
  await first.close(50);
});

test("a closing producer is never reused as the process singleton", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const first = createProducerSink({
    paths,
    config: config("metadata"),
    transport: {
      send: () => new Promise(() => {}),
      close() {},
    },
  });
  first.emit(pending({ phase: "first" }, "workflow.phase"));
  void first.flush(50);
  const closing = first.close(25);
  const second = createProducerSink({
    paths,
    config: config("metadata"),
    transport: unavailableTransport(),
  });
  assert.notEqual(second, first);
  second.emit(pending({ phase: "second" }, "workflow.phase"));
  assert.equal(second.stats.queueEvents, 1);
  await closing;
  assert.equal(currentProducerSink(), second);
  await second.close(50);
});

test("live producer survives daemon restart/token rotation and replays before new traffic", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const controller = createDaemonController({ paths, autostart: true });
  assert.equal(await controller.ensureDaemon(), true);
  let daemonPid = JSON.parse(fs.readFileSync(paths.state, "utf8"))
    .pid as number;
  t.after(async () => {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // Already stopped.
    }
    await waitFor(() => !fs.existsSync(paths.state)).catch(() => undefined);
  });
  const sink = createProducerSink({
    paths,
    config: config("metadata"),
    ensureDaemon: () => controller.ensureDaemon(),
  });
  sink.emit(
    pending(
      { name: "before-restart", background: false, phaseCount: 0 },
      "workflow.started",
    ),
  );
  await sink.flush(3_000);

  process.kill(daemonPid, "SIGTERM");
  await waitFor(() => !fs.existsSync(paths.state));
  sink.emit(
    pending(
      { name: "after-restart", background: false, phaseCount: 0 },
      "workflow.started",
    ),
  );
  assert.equal(await controller.ensureDaemon(), true);
  daemonPid = JSON.parse(fs.readFileSync(paths.state, "utf8")).pid;
  await sink.flush(3_000);

  const database = new DatabaseSync(paths.database, { readOnly: true });
  const count = database
    .prepare("SELECT COUNT(*) AS count FROM events")
    .get() as { count: number };
  database.close();
  assert.equal(count.count, 2);
  assert.equal(
    createProtectedSpool({ paths, producerId: sink.producerId }).scanSegments()
      .length,
    0,
  );
  await sink.close(100);
});

test("producer redacts before immutable spool and replay adopts the segment", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const producerId = mintProducerId();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const sink = createProducerSink({
    paths,
    config: config("rich"),
    producerId,
    richAllowed: true,
    transport: unavailableTransport(),
  });

  assert.doesNotThrow(() =>
    sink.emit(pending({ message: `Authorization: Bearer ${secret}` })),
  );
  await sink.flush(1_000);
  const spool = createProtectedSpool({ paths, producerId });
  const [segment] = spool.scanSegments();
  assert.ok(segment);
  const stored = fs.readFileSync(segment.file, "utf8");
  assert.equal(stored.includes(secret), false);
  assert.match(stored, /REDACTED/);
  assert.equal(fs.statSync(path.dirname(segment.file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(segment.file).mode & 0o777, 0o600);

  const replayed: unknown[] = [];
  await spool.replay(async (events) => {
    replayed.push(...events);
    return { terminal: events.map(() => true) };
  });
  assert.equal(replayed.length, 1);
  assert.equal(spool.scanSegments().length, 0);
  await sink.close(50);
});

test("production safety cap narrows explicit rich policy to metadata", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const sink = createProducerSink({
    paths,
    config: config("rich"),
    richAllowed: false,
    transport: unavailableTransport(),
  });
  assert.equal(sink.contentModeFor(process.cwd()), "metadata");
  sink.emit(pending({ message: "private-content" }));
  await sink.flush(1_000);
  const spool = createProtectedSpool({ paths, producerId: sink.producerId });
  const [segment] = spool.scanSegments();
  assert.ok(segment);
  const stored = fs.readFileSync(segment.file, "utf8");
  assert.equal(stored.includes("private-content"), false);
  assert.match(stored, /"contentMode":"metadata"/);
  await sink.close(50);
});

test("producer fails closed to metadata when project attribution is absent", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const sink = createProducerSink({
    paths,
    config: config("rich"),
    richAllowed: true,
    transport: unavailableTransport(),
  });
  assert.equal(sink.contentModeFor(undefined), "metadata");
  const { project: _project, ...unattributed } = pending({
    message: "NO-PROJECT-CONTENT",
  });
  sink.emit(unattributed);
  await sink.flush(1_000);
  const spool = createProtectedSpool({ paths, producerId: sink.producerId });
  const [segment] = spool.scanSegments();
  assert.ok(segment);
  const stored = fs.readFileSync(segment.file, "utf8");
  assert.equal(stored.includes("NO-PROJECT-CONTENT"), false);
  assert.match(stored, /"contentMode":"metadata"/);
  await sink.close(50);
});

test("usage/meta queue entries coalesce without reusing event IDs", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const sink = createProducerSink({
    paths,
    config: config("metadata"),
    transport: unavailableTransport(),
  });
  for (let index = 0; index < 10; index++) {
    sink.emit(
      pending(
        { displayId: "sa-1", tokens: index, update: "session" },
        "agent.usage",
      ),
    );
  }
  assert.equal(sink.stats.queueEvents, 1);
  assert.equal(sink.stats.coalesced, 9);
  assert.equal(sink.stats.producerSeq, 1);
  await sink.close(50);
  const spool = createProtectedSpool({ paths, producerId: sink.producerId });
  const [segment] = spool.scanSegments();
  assert.ok(segment);
  const [stored] = fs.readFileSync(segment.file, "utf8").trim().split("\n");
  assert.equal(JSON.parse(stored).producer.seq, 1);
});

test("coalescing stays contiguous at the daemon and health counts transitions", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const controller = createDaemonController({ paths, autostart: true });
  assert.equal(await controller.ensureDaemon(), true);
  const daemonPid = JSON.parse(fs.readFileSync(paths.state, "utf8"))
    .pid as number;
  t.after(async () => {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // Already stopped.
    }
    await waitFor(() => !fs.existsSync(paths.state)).catch(() => undefined);
  });
  const sink = createProducerSink({
    paths,
    config: config("metadata"),
    ensureDaemon: () => controller.ensureDaemon(),
  });
  for (let index = 0; index < 10; index++) {
    sink.emit(
      pending(
        { displayId: "sa-1", tokens: index, update: "session" },
        "agent.usage",
      ),
    );
  }
  sink.emit(
    pending(
      { name: "after-usage", background: false, phaseCount: 0 },
      "workflow.started",
    ),
  );
  await sink.flush(3_000);
  let metrics = JSON.parse(fs.readFileSync(paths.metrics, "utf8"));
  assert.equal(metrics.producerGaps, 0);
  assert.equal(sink.stats.healthTransitions, 1);

  sink.emit(
    pending(
      { name: "second-batch", background: false, phaseCount: 0 },
      "workflow.started",
    ),
  );
  await sink.flush(3_000);
  metrics = JSON.parse(fs.readFileSync(paths.metrics, "utf8"));
  assert.equal(metrics.producerGaps, 0);
  assert.equal(sink.stats.healthTransitions, 1);
  await sink.close(100);
});

test("hard pressure preserves producer order and keeps state producer-local", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const sink = createProducerSink({
    paths,
    config: config("metadata"),
    transport: {
      send: () => new Promise(() => {}),
      close() {},
    },
  });
  for (let index = 0; index < 600; index++) {
    sink.emit(
      pending(
        { phase: `phase-${index}`, knownPhaseCount: 600 },
        "workflow.phase",
      ),
    );
  }
  await sink.close(500);
  const spool = createProtectedSpool({ paths, producerId: sink.producerId });
  const sequences = spool.scanSegments().flatMap((segment) =>
    fs
      .readFileSync(segment.file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).producer.seq as number),
  );
  assert.deepEqual(
    sequences,
    Array.from({ length: 600 }, (_, index) => index + 1),
  );
  assert.equal(fs.existsSync(paths.spoolState), false);
  assert.equal(
    fs.existsSync(path.join(paths.spoolDir, sink.producerId, "state.json")),
    true,
  );
});

test("shutdown is bounded and spools all queued records before a hanging transport", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const sink = createProducerSink({
    paths,
    config: config("metadata"),
    transport: {
      send: () => new Promise(() => {}),
      close() {},
    },
  });
  for (let index = 0; index < 80; index++) {
    sink.emit(
      pending(
        { phase: `phase-${index}`, knownPhaseCount: 80 },
        "workflow.phase",
      ),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await sink.close(30);
  assert.ok(Date.now() - started < 250);
  const spool = createProtectedSpool({ paths, producerId: sink.producerId });
  assert.ok(spool.scanSegments().length > 0);
});

test("zero shutdown budget starts no synchronous spool scan", async (t) => {
  resetProducerSinkForTests();
  t.after(resetProducerSinkForTests);
  const paths = tempPaths(t);
  const sink = createProducerSink({
    paths,
    config: config("metadata"),
    transport: unavailableTransport(),
  });
  sink.emit(pending({ phase: "queued" }, "workflow.phase"));
  const started = Date.now();
  await sink.close(0);
  assert.ok(Date.now() - started < 100);
  assert.equal(sink.stats.reasons["shutdown-budget-exhausted"], 1);
});

test("stale temp recovery promotes complete redacted lines and discards the partial tail", (t) => {
  const paths = tempPaths(t);
  const producerId = mintProducerId();
  const spool = createProtectedSpool({
    paths,
    producerId,
    staleTempMs: 0,
  });
  const normalized = normalizeProducerEnvelope({
    ...pending({ message: "safe" }),
    producer: { id: producerId, seq: 1, kind: "pi" },
  });
  const directory = path.join(paths.spoolDir, producerId);
  const temporary = path.join(
    directory,
    ".00000001.ndjson.123.0000000000000000.tmp",
  );
  fs.writeFileSync(temporary, `${normalized.serialized}\n{"partial"`, {
    mode: 0o600,
  });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(temporary, stale, stale);
  spool.recoverStaleTemps();
  assert.equal(spool.counters.partialTails, 1);
  assert.equal(spool.scanSegments().length, 1);
  assert.equal(fs.existsSync(temporary), false);
});

test("stable protected reads never delete a replacement path", (t) => {
  const paths = tempPaths(t);
  const producerId = mintProducerId();
  createProtectedSpool({ paths, producerId });
  const file = path.join(paths.spoolDir, producerId, "00000001.ndjson");
  const moved = `${file}.moved`;
  fs.writeFileSync(file, "original\n", { mode: 0o600 });
  const stable = readStableProtectedFile(file, 1024);
  fs.renameSync(file, moved);
  fs.writeFileSync(file, "replacement\n", { mode: 0o600 });
  assert.equal(unlinkProtectedFile(file, stable.identity), false);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement\n");
  assert.equal(stable.bytes.toString("utf8"), "original\n");
});

test("fresh incomplete temps are not misreported as malformed", (t) => {
  const paths = tempPaths(t);
  const producerId = mintProducerId();
  const spool = createProtectedSpool({
    paths,
    producerId,
    staleTempMs: 60_000,
  });
  const directory = path.join(paths.spoolDir, producerId);
  const temporary = path.join(
    directory,
    ".00000001.ndjson.123.0000000000000000.tmp",
  );
  fs.writeFileSync(temporary, "incomplete", { mode: 0o600 });
  spool.recoverStaleTemps();
  assert.equal(spool.counters.malformedRecords, 0);
  assert.equal(spool.counters.quarantined, 0);
  assert.equal(fs.existsSync(temporary), true);
});

test("spool cap evicts oldest durable segments with safe gap counts", (t) => {
  const paths = tempPaths(t);
  const producerId = mintProducerId();
  const spool = createProtectedSpool({
    paths,
    producerId,
    maxBytes: 1024 * 1024,
    segmentMaxBytes: 700 * 1024,
  });
  let sequence = 0;
  const records = Array.from({ length: 18 }, () => {
    const normalized = normalizeProducerEnvelope({
      ...pending({ message: "x".repeat(60 * 1024) }),
      eventId: mintEventId(),
      producer: { id: producerId, seq: ++sequence, kind: "pi" },
    });
    return {
      event: normalized.event,
      serialized: normalized.serialized,
      bytes: normalized.bytes,
      coalescable: false,
    };
  });
  spool.writeRecords(records.slice(0, 6));
  spool.writeRecords(records.slice(6, 12));
  spool.writeRecords(records.slice(12));
  const total = spool
    .scanSegments()
    .reduce((sum, segment) => sum + segment.size, 0);
  assert.ok(total <= 1024 * 1024);
  assert.ok(spool.counters.evictedSegments > 0);
  assert.ok(spool.counters.evictedRecords > 0);
});

test("hostile producer directory names are never accepted as path fragments", (t) => {
  const paths = tempPaths(t);
  const producerId = mintProducerId();
  const spool = createProtectedSpool({ paths, producerId });
  const hostile = path.join(paths.spoolDir, "producer_..escape");
  fs.mkdirSync(hostile, { mode: 0o700 });
  fs.writeFileSync(path.join(hostile, "00000001.ndjson"), "secret\n", {
    mode: 0o600,
  });
  assert.equal(spool.scanSegments().length, 0);
  assert.throws(
    () =>
      createProtectedSpool({
        paths,
        producerId: "producer_../escape" as ProducerId,
      }),
    /invalid-producer-id/,
  );
});
