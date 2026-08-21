import assert from "node:assert/strict";
import test from "node:test";
import { createRecordingSink } from "../shared/observability/sink.ts";
import { WORKFLOW_LOG_ENTRY_MAX_CHARS, type WorkflowDetails } from "./model.ts";
import { createWorkflowRunEmitter } from "./observability.ts";

function details(
  status: WorkflowDetails["status"] = "running",
): WorkflowDetails {
  return {
    runId: "wf_abcdef123456",
    sessionId: "pi-session-native",
    name: "observability test",
    background: false,
    status,
    startedAt: 1_000,
    phases: [{ title: "prepare" }],
    currentPhase: "prepare",
    agents: [],
    logs: [],
  };
}

test("workflow emitter produces run-only events in deterministic order", () => {
  const sink = createRecordingSink();
  const run = details();
  let clock = 2_000;
  const emitter = createWorkflowRunEmitter({
    runId: run.runId,
    sessionId: run.sessionId,
    cwd: "/tmp/workflow-project",
    sink,
    now: () => clock++,
  });

  emitter.started(run);
  run.currentPhase = "review";
  run.phases.push({ title: "review" });
  emitter.phase(run, "review");
  const oversizedLog = "😀".repeat(WORKFLOW_LOG_ENTRY_MAX_CHARS + 100);
  emitter.log(oversizedLog);
  run.status = "completed";
  run.finishedAt = 4_000;
  emitter.settled(run);

  assert.deepEqual(
    sink.events.map((event) => event.kind),
    ["workflow.started", "workflow.phase", "workflow.log", "workflow.settled"],
  );
  assert.ok(sink.events.every((event) => !event.kind.startsWith("agent.")));
  assert.deepEqual(
    sink.events.map((event) => event.producer.seq),
    [1, 2, 3, 4],
  );
  assert.ok(
    sink.events.every(
      (event) =>
        event.ids.runId === run.runId &&
        event.ids.traceId === "pi-session:pi-session-native" &&
        event.ids.parentRunId === "pi-run:pi-session-native",
    ),
  );

  const log = sink.events.find((event) => event.kind === "workflow.log");
  assert.equal(
    (log?.payload as { message: string }).message.length,
    WORKFLOW_LOG_ENTRY_MAX_CHARS,
  );
  assert.equal(log?.capture.contentMode, "rich");
  const settled = sink.events.find(
    (event) => event.kind === "workflow.settled",
  );
  assert.deepEqual(settled?.payload, {
    status: "completed",
    durationMs: 3_000,
    agentCount: 0,
    completedAgentCount: 0,
    failedAgentCount: 0,
  });
});

test("workflow settlement maps completed, failed, and aborted without agent events", () => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    const sink = createRecordingSink();
    const run = details(status);
    run.finishedAt = 2_500;
    if (status !== "completed") run.error = `${status}: ${"x".repeat(80_000)}`;
    const emitter = createWorkflowRunEmitter({
      runId: run.runId,
      sessionId: run.sessionId,
      cwd: "/tmp/workflow-project",
      sink,
    });
    emitter.settled(run);
    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0]?.kind, "workflow.settled");
    assert.equal(
      (sink.events[0]?.payload as { status: string }).status,
      status,
    );
    assert.ok(sink.events[0]!.capture.truncated === (status !== "completed"));
    assert.equal(
      sink.events[0]!.capture.contentMode,
      status === "completed" ? "metadata" : "rich",
    );
    assert.ok(
      JSON.stringify(sink.events[0]).length < 80_000,
      "bounded errors must not retain the oversized tail",
    );
  }
});

test("workflow emitter fallback identities are unique and internally paired", () => {
  const firstSink = createRecordingSink();
  const secondSink = createRecordingSink();
  createWorkflowRunEmitter({
    runId: "wf_000000000001",
    cwd: "/tmp/workflow-project",
    sink: firstSink,
  }).started(details());
  createWorkflowRunEmitter({
    runId: "wf_000000000002",
    cwd: "/tmp/workflow-project",
    sink: secondSink,
  }).started(details());

  const first = firstSink.events[0]!.ids;
  const second = secondSink.events[0]!.ids;
  assert.notEqual(first.traceId, second.traceId);
  assert.equal(
    first.traceId?.replace("pi-session:", "pi-run:"),
    first.parentRunId,
  );
});

test("workflow emitter isolates a sink that violates the non-throwing contract", () => {
  const run = details();
  const emitter = createWorkflowRunEmitter({
    runId: run.runId,
    sessionId: run.sessionId,
    cwd: "/tmp/workflow-project",
    sink: {
      emit: () => {
        throw new Error("hostile sink");
      },
      flush: async () => {
        throw new Error("hostile flush");
      },
    },
  });

  assert.doesNotThrow(() => {
    emitter.started(run);
    emitter.phase(run, "phase");
    emitter.log("log");
    run.status = "aborted";
    run.finishedAt = 2_000;
    emitter.settled(run);
  });
  assert.equal(run.status, "aborted");
});
