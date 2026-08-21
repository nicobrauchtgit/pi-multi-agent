import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  C0_EMITTED_KINDS,
  METADATA_TEXT_MAX_BYTES,
  OBSERVABILITY_ENVELOPE_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  STORED_EVENT_MAX_BYTES,
  boundText,
  boundedProjectIdentity,
  buildC0Event,
  captureFromBoundedText,
  estimateEventBytes,
  type PendingObservabilityEvent,
} from "./observability/events.ts";
import {
  isAgentId,
  isEventId,
  isProducerId,
  isStandaloneRunId,
  isTurnId,
  isWorkflowRunId,
  mintAgentId,
  mintEphemeralParentIdentity,
  mintEventId,
  mintProducerId,
  mintStandaloneRunId,
  mintTurnId,
  parentIdentityFromPiSession,
} from "./observability/ids.ts";
import {
  NOOP_OBSERVABILITY_SINK,
  createRecordingSink,
  safeEmit,
  type ObservabilitySink,
} from "./observability/sink.ts";

function workflowPhaseEvent(
  phase: string,
): PendingObservabilityEvent<"workflow.phase"> {
  const bounded = boundText(phase, METADATA_TEXT_MAX_BYTES, "payload.phase");
  return buildC0Event({
    kind: "workflow.phase",
    ids: {
      traceId: "pi-session:test",
      runId: "wf_000000000001",
      parentRunId: "pi-run:test",
    },
    payload: { phase: bounded.value, knownPhaseCount: 1 },
    capture: captureFromBoundedText("metadata", [bounded]),
  });
}

test("locally minted observability IDs use exact UUIDv4 grammars", () => {
  const agents = new Set<string>();
  const turns = new Set<string>();
  const events = new Set<string>();
  const runs = new Set<string>();
  const producers = new Set<string>();
  for (let index = 0; index < 10_000; index++) {
    const agentId = mintAgentId();
    const turnId = mintTurnId();
    const eventId = mintEventId();
    const runId = mintStandaloneRunId();
    const producerId = mintProducerId();
    assert.equal(isAgentId(agentId), true);
    assert.equal(isTurnId(turnId), true);
    assert.equal(isEventId(eventId), true);
    assert.equal(isStandaloneRunId(runId), true);
    assert.equal(isProducerId(producerId), true);
    agents.add(agentId);
    turns.add(turnId);
    events.add(eventId);
    runs.add(runId);
    producers.add(producerId);
  }
  assert.equal(agents.size, 10_000);
  assert.equal(turns.size, 10_000);
  assert.equal(events.size, 10_000);
  assert.equal(runs.size, 10_000);
  assert.equal(producers.size, 10_000);

  for (const invalid of [
    "agent_../escape",
    "agent_00000000-0000-1000-8000-000000000000",
    "turn_%2Ftmp",
    "event_00000000-0000-4000-7000-000000000000",
    "sa_00000000-0000-4000-8000-000000000000/child",
    "producer_not-a-uuid",
  ]) {
    assert.equal(isAgentId(invalid), false);
    assert.equal(isTurnId(invalid), false);
    assert.equal(isEventId(invalid), false);
    assert.equal(isStandaloneRunId(invalid), false);
    assert.equal(isProducerId(invalid), false);
  }

  assert.deepEqual(parentIdentityFromPiSession("session/opaque"), {
    traceId: "pi-session:session/opaque",
    rootRunId: "pi-run:session/opaque",
  });
  assert.equal(isWorkflowRunId("wf_abcdef123456"), true);
  assert.equal(isWorkflowRunId("wf_ABCDEF123456"), false);
  assert.equal(isWorkflowRunId("workflow-run"), false);

  const ephemeralOne = mintEphemeralParentIdentity();
  const ephemeralTwo = mintEphemeralParentIdentity();
  assert.notEqual(ephemeralOne.traceId, ephemeralTwo.traceId);
  assert.equal(
    ephemeralOne.traceId.replace("pi-session:", "pi-run:"),
    ephemeralOne.rootRunId,
  );
});

test("project identity canonicalizes symlinks and hashes the exact stored root", (t) => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-obs-project-"));
  const linkedRoot = `${realRoot}-link`;
  fs.symlinkSync(realRoot, linkedRoot, "dir");
  t.after(() => {
    fs.rmSync(linkedRoot, { force: true });
    fs.rmSync(realRoot, { force: true, recursive: true });
  });

  const { project, rootField } = boundedProjectIdentity(linkedRoot);
  assert.equal(project.root, fs.realpathSync.native(realRoot));
  assert.equal(rootField.value, project.root);
  assert.equal(
    project.id,
    `sha256:${createHash("sha256").update(project.root).digest("hex")}`,
  );
});

test("v1 events are additive and oversized text is UTF-8-safe and marked", () => {
  const oversized = `${"😀".repeat(2_000)}\n${'\\"'.repeat(2_000)}`;
  const bounded = boundText(
    oversized,
    METADATA_TEXT_MAX_BYTES,
    "payload.phase",
  );
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.storedBytes <= METADATA_TEXT_MAX_BYTES);
  assert.equal(bounded.value.includes("�"), false);

  const event = buildC0Event({
    kind: "workflow.phase",
    ids: { runId: "wf_000000000001" },
    payload: {
      phase: bounded.value,
      knownPhaseCount: 1,
      futureAdditiveField: "accepted by structural consumers",
    },
    capture: captureFromBoundedText("metadata", [bounded]),
  });
  assert.equal(event.v, OBSERVABILITY_ENVELOPE_VERSION);
  assert.equal(event.schemaVersion, OBSERVABILITY_SCHEMA_VERSION);
  assert.equal(event.capture.truncated, true);
  assert.deepEqual(event.capture.truncatedFields, ["payload.phase"]);
  assert.ok(isEventId(event.eventId));
  assert.ok(estimateEventBytes(event) < STORED_EVENT_MAX_BYTES);
  assert.ok(C0_EMITTED_KINDS.includes(event.kind));
});

test("no-op and safe sink boundaries swallow malformed and hostile input", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() =>
    NOOP_OBSERVABILITY_SINK.emit(
      cyclic as unknown as PendingObservabilityEvent<string>,
    ),
  );
  await NOOP_OBSERVABILITY_SINK.flush(-1);

  const hostile: ObservabilitySink = {
    emit: () => {
      throw new Error("sink fault");
    },
    flush: async () => {
      throw new Error("flush fault");
    },
  };
  assert.doesNotThrow(() => safeEmit(hostile, workflowPhaseEvent("safe")));
});

test("recording sink assigns ordered producer sequences and bounds storage", () => {
  const sink = createRecordingSink({ maxEvents: 2, maxBytes: 1024 * 1024 });
  sink.emit(workflowPhaseEvent("one"));
  sink.emit(workflowPhaseEvent("two"));
  sink.emit(workflowPhaseEvent("three"));

  assert.equal(sink.events.length, 2);
  assert.deepEqual(
    sink.events.map((event) => event.producer.seq),
    [2, 3],
  );
  assert.ok(
    sink.events.every((event) => event.producer.id === sink.producerId),
  );
  assert.equal(sink.stats.droppedByReason.capacity, 1);

  const unknown = {
    ...workflowPhaseEvent("future"),
    eventId: mintEventId(),
    kind: "future.adapter.kind",
    payload: { future: true, nested: { additive: "field" } },
  } satisfies PendingObservabilityEvent<string>;
  sink.emit(unknown);
  assert.equal(sink.events.at(-1)?.kind, "future.adapter.kind");

  const oversized = {
    ...unknown,
    eventId: mintEventId(),
    payload: { text: "x".repeat(STORED_EVENT_MAX_BYTES) },
  };
  sink.emit(oversized);
  assert.equal(sink.stats.droppedByReason["event-too-large"], 1);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  sink.emit(cyclic as unknown as PendingObservabilityEvent<string>);
  assert.equal(sink.stats.droppedByReason.invalid, 1);

  sink.emit({ ...workflowPhaseEvent("after drops"), eventId: mintEventId() });
  assert.equal(sink.events.at(-1)?.producer.seq, 7);

  sink.clear();
  assert.equal(sink.events.length, 0);
  assert.deepEqual(sink.stats, {
    accepted: 0,
    dropped: 0,
    currentBytes: 0,
    droppedByReason: { invalid: 0, "event-too-large": 0, capacity: 0 },
  });
  sink.emit(workflowPhaseEvent("after clear"));
  assert.equal(sink.events[0]?.producer.seq, 1);
});
