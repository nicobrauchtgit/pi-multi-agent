/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus a
 * deliberately failing pi fixture for spawn-cleanup coverage.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { METADATA_TEXT_MAX_BYTES } from "../shared/observability/events.ts";
import {
  isAgentId,
  isStandaloneRunId,
  isTurnId,
} from "../shared/observability/ids.ts";
import {
  ObservabilitySinkService,
  createRecordingSink,
  type ObservabilitySink,
  type RecordingObservabilitySink,
} from "../shared/observability/sink.ts";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import {
  SpawnError,
  type BackendName,
  type ParentContext,
  type SpawnTask,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  SubagentManagerWithSink,
  type SubagentManagerShape,
} from "./src/manager.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    {
      name: "pi",
      capabilities: {
        steering: true,
        modelSelection: true,
        reasoningEffort: true,
      },
      available: Effect.succeed(true),
      spawn: () => new SpawnError({ message: "fixture backend spawn failed" }),
    },
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
      sendResolutionDelayMs: 600,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

function registryLayer(backends: ReadonlyArray<SubagentBackend>) {
  return Layer.succeed(
    BackendRegistry,
    new Map<BackendName, SubagentBackend>(
      backends.map((backend) => [backend.name, backend]),
    ),
  );
}

function createObservedRuntime(
  sink: ObservabilitySink,
  registry = TestRegistryLive,
) {
  return ManagedRuntime.make(
    SubagentManagerWithSink.pipe(
      Layer.provide(registry),
      Layer.provide(Layer.succeed(ObservabilitySinkService, sink)),
    ),
  );
}

function runTool<A, E>(
  runtime: ReturnType<typeof createTestRuntime>,
  effect: Effect.Effect<A, E>,
) {
  return runtime.runPromise(effect);
}

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

async function withObservedManager(
  sink: ObservabilitySink,
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createObservedRuntime>,
  ) => Promise<void>,
  registry = TestRegistryLive,
) {
  const runtime = createObservedRuntime(sink, registry);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin, delivery defaults, and workflow ownership propagate", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{
      id: string;
      origin: string;
      autoDeliver: boolean;
    }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({
        id: snap.id,
        origin: snap.origin,
        autoDeliver: snap.autoDeliver,
      }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );
    const workflow = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("workflow task"),
        origin: "workflow",
        workflowRunId: "wf_000000000001",
        workflowAgentIndex: 2,
        workflowPhase: "review",
        workflowLabel: "codex review",
      }),
    );
    const silentModel = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("manually collected model task"),
        autoDeliver: false,
      }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.equal(model.autoDeliver, true);
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");
    assert.equal(btw.autoDeliver, false);
    assert.match(workflow.id, /^sa-/);
    assert.equal(workflow.origin, "workflow");
    assert.equal(workflow.autoDeliver, false);
    assert.equal(workflow.workflowRunId, "wf_000000000001");
    assert.equal(workflow.workflowAgentIndex, 2);
    assert.equal(workflow.workflowPhase, "review");
    assert.equal(workflow.workflowLabel, "codex review");
    assert.equal(silentModel.origin, "model");
    assert.equal(silentModel.autoDeliver, false);
    // The synchronous read model is the unfiltered source for /subagents.
    assert.ok(manager.view.list().some((snap) => snap.id === workflow.id));

    await runTool(
      runtime,
      manager.cancel([model.id, btw.id, workflow.id, silentModel.id]),
    );
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw", autoDeliver: false },
        { id: model.id, origin: "model", autoDeliver: true },
        { id: silentModel.id, origin: "model", autoDeliver: false },
        { id: workflow.id, origin: "workflow", autoDeliver: false },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("a workflow bridge can spawn, wait, and read one structured settlement", async () => {
  await withManager(async (manager, runtime) => {
    const schema = {
      type: "object",
      properties: {
        prompt: { type: "string" },
        turn: { type: "number" },
      },
      required: ["prompt", "turn"],
      additionalProperties: false,
    };
    const settlements: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => {
      settlements.push({ id: snap.id, consumed });
    });

    const started = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("Return workflow data"),
        origin: "workflow",
        autoDeliver: true,
        workflowRunId: "wf_000000000002",
        workflowAgentIndex: 3,
        workflowPhase: "synthesize",
        workflowLabel: "structured synthesis",
        schema,
      }),
    );
    assert.equal(started.autoDeliver, false);

    await runTool(runtime, manager.waitFor([started.id]));
    const settled = await runTool(runtime, manager.get(started.id));

    assert.ok(settled);
    assert.equal(settled.status, "done");
    assert.equal(settled.origin, "workflow");
    assert.equal(settled.autoDeliver, false);
    assert.equal(settled.workflowRunId, "wf_000000000002");
    assert.equal(settled.workflowAgentIndex, 3);
    assert.equal(settled.workflowPhase, "synthesize");
    assert.equal(settled.workflowLabel, "structured synthesis");
    assert.deepEqual(settled.schema, schema);
    assert.deepEqual(settled.structured, {
      prompt: "Return workflow data",
      turn: 1,
    });
    assert.deepEqual(settlements, [{ id: started.id, consumed: true }]);
  });
});

test("the global concurrency cap includes every origin", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      {
        ...task("workflow task"),
        origin: "workflow",
        workflowRunId: "wf_000000000003",
        workflowAgentIndex: 0,
      },
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) =>
          manager.spawn(
            "codex",
            n === 1
              ? {
                  ...task(`Task ${n}`),
                  schema: { type: "object", properties: {} },
                }
              : task(`Task ${n}`),
          ),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("failed backend spawn releases its concurrency reservation", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("cannot start"))),
      /fixture backend spawn failed/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("a backend that resolves send after settlement cannot erase the fresh result", async () => {
  await withManager(async (manager, runtime) => {
    const schema = {
      type: "object",
      properties: {
        prompt: { type: "string" },
        turn: { type: "number" },
      },
      required: ["prompt", "turn"],
      additionalProperties: false,
    };
    const started = await runTool(
      runtime,
      manager.spawn("codex", { ...task("First delayed turn"), schema }),
    );
    await runTool(runtime, manager.waitFor([started.id]));

    await runTool(runtime, manager.send(started.id, "Second delayed turn"));
    const settledBeforeSendResolved = manager.view.get(started.id);
    assert.equal(settledBeforeSendResolved?.status, "done");
    assert.deepEqual(settledBeforeSendResolved?.structured, {
      prompt: "Second delayed turn",
      turn: 2,
    });
  });
});

test("structured state is replaced per turn and schema failures retain partial state", async () => {
  await withManager(async (manager, runtime) => {
    const schema = {
      type: "object",
      properties: {
        prompt: { type: "string" },
        turn: { type: "number" },
      },
      required: ["prompt", "turn"],
      additionalProperties: false,
    };
    const started = await runTool(
      runtime,
      manager.spawn("claude", { ...task("First structured turn"), schema }),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    assert.deepEqual(manager.view.get(started.id)?.schema, schema);
    assert.deepEqual(manager.view.get(started.id)?.structured, {
      prompt: "First structured turn",
      turn: 1,
    });
    assert.equal(manager.view.get(started.id)?.schemaError, undefined);

    await runTool(
      runtime,
      manager.send(started.id, "SCHEMA_FAIL: second structured turn"),
    );
    // send() clears the previous result before the asynchronous RunStarted
    // event can be folded, so follow-up callers cannot observe stale data.
    assert.equal(manager.view.get(started.id)?.structured, undefined);
    assert.equal(manager.view.get(started.id)?.schemaError, undefined);
    await runTool(runtime, manager.waitFor([started.id]));

    const failed = manager.view.get(started.id);
    assert.equal(failed?.status, "error");
    assert.equal(failed?.structured, undefined);
    assert.match(failed?.schemaError ?? "", /did not match the schema/);
    assert.match(failed?.errorText ?? "", /did not match the schema/);

    await runTool(runtime, manager.send(started.id, "Third structured turn"));
    assert.equal(manager.view.get(started.id)?.schemaError, undefined);
    await runTool(runtime, manager.waitFor([started.id]));
    assert.deepEqual(manager.view.get(started.id)?.structured, {
      prompt: "Third structured turn",
      turn: 3,
    });
  });
});

test("interrupting a follow-up clears the prior structured result", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("First structured turn"),
        schema: { type: "object", properties: {} },
      }),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    assert.notEqual(manager.view.get(started.id)?.structured, undefined);

    await runTool(runtime, manager.send(started.id, "Interrupted turn"));
    while (manager.view.get(started.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await runTool(runtime, manager.cancel([started.id]));
    const interrupted = manager.view.get(started.id);
    assert.equal(interrupted?.structured, undefined);
    assert.equal(interrupted?.schemaError, undefined);
    assert.equal(interrupted?.errorText, "Run was aborted");
  });
});

test("schema-less runs retain the original snapshot behavior", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.spawn("codex", task("Ordinary turn")),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    const done = manager.view.get(started.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.structured, undefined);
    assert.equal(done?.schemaError, undefined);
    assert.match(done?.finalText ?? "", /Ordinary turn/);
  });
});

test("resumeRole compares schema overrides with the live session contract", async () => {
  await withManager(async (manager, runtime) => {
    const first = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("First role turn"),
        role: "reviewer",
        schema: {
          type: "object",
          properties: { prompt: { type: "string" }, turn: { type: "number" } },
          required: ["prompt", "turn"],
        },
      }),
    );
    await runTool(runtime, manager.waitFor([first.id]));

    await assert.rejects(
      runTool(
        runtime,
        manager.resumeRole("claude", {
          ...task("Changed contract"),
          role: "reviewer",
          schema: { type: "object", properties: {} },
        }),
      ),
      /schema cannot be changed/,
    );
    assert.equal(manager.view.get(first.id)?.status, "done");
  });
});

test("resumeRole routes a tracked role to the existing native session", async () => {
  await withManager(async (manager, runtime) => {
    const first = await runTool(
      runtime,
      manager.spawn("claude", { ...task("First role turn"), role: "reviewer" }),
    );
    await runTool(runtime, manager.waitFor([first.id]));

    const resumed = await runTool(
      runtime,
      manager.resumeRole("claude", {
        ...task("Second role turn"),
        role: "reviewer",
      }),
    );
    assert.equal(resumed.reopened, false);
    assert.equal(resumed.snapshot.id, first.id);
    await runTool(runtime, manager.waitFor([first.id]));
    assert.match(
      manager.view.get(first.id)?.finalText ?? "",
      /Second role turn/,
    );
  });
});

test("resumeRole reopens native history under a fresh current-session id", async () => {
  await withManager(async (manager, runtime) => {
    const resumed = await runTool(
      runtime,
      manager.resumeRole("codex", {
        ...task("Continue saved work"),
        role: "researcher",
        resume: {
          nativeSessionId: "saved-codex-thread",
          sessionFilePath: "/tmp/saved-codex-thread.jsonl",
        },
      }),
    );
    assert.equal(resumed.reopened, true);
    assert.match(resumed.snapshot.id, /^sa-/);
    assert.equal(resumed.snapshot.meta.nativeSessionId, "saved-codex-thread");
    await runTool(runtime, manager.waitFor([resumed.snapshot.id]));
  });
});

test("failed spawn releases its role lease", async () => {
  await withManager(async (manager, runtime) => {
    let releases = 0;
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("pi", {
          ...task("cannot start"),
          role: "leased",
          roleLease: { release: () => releases++ },
        }),
      ),
      /fixture backend spawn failed/,
    );
    assert.equal(releases, 1);
  });
});

test("reservation rejection releases its role lease", async () => {
  await withManager(async (manager, runtime) => {
    const running = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`occupy ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    let capReleases = 0;
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("rejected by cap"),
          role: "cap-rejected",
          roleLease: { release: () => capReleases++ },
        }),
      ),
      /Max 4 subagents/,
    );
    assert.equal(capReleases, 1);
    await runTool(
      runtime,
      manager.cancel(running.map((snapshot) => snapshot.id)),
    );

    await runTool(runtime, manager.disposeAll);
    let shutdownReleases = 0;
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("rejected by shutdown"),
          role: "shutdown-rejected",
          roleLease: { release: () => shutdownReleases++ },
        }),
      ),
      /shutting down/,
    );
    assert.equal(shutdownReleases, 1);
  });
});

test("workflow-origin reservations require the repository workflow ID grammar", async () => {
  const recording = createRecordingSink();
  await withObservedManager(recording, async (manager, runtime) => {
    let releases = 0;
    for (const workflowRunId of [undefined, "workflow-run-invalid"]) {
      await assert.rejects(
        runTool(
          runtime,
          manager.spawn("codex", {
            ...task("invalid workflow identity"),
            origin: "workflow",
            role: "invalid-workflow-role",
            roleLease: { release: () => releases++ },
            ...(workflowRunId ? { workflowRunId } : {}),
          }),
        ),
        /valid workflowRunId/,
      );
    }
    assert.equal(releases, 2);
    assert.deepEqual(recording.events, []);
  });
});

test("interrupted spawn emits error and settlement after creation", async () => {
  const recording = createRecordingSink();
  let releases = 0;
  const backend: SubagentBackend = {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.never,
    spawn: () => Effect.die("unreachable spawn"),
  };
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const fiber = runtime.runFork(
        manager.spawn("pi", {
          ...task("interrupt reservation"),
          roleLease: { release: () => releases++ },
        }),
      );
      while (recording.events.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await runtime.runPromise(Fiber.interrupt(fiber));
      assert.deepEqual(
        recording.events.map((event) => event.kind),
        ["agent.created", "agent.error", "agent.settled"],
      );
      assert.ok(
        recording.events
          .slice(1)
          .every((event) => event.capture.contentMode === "rich"),
      );
    },
    registryLayer([backend]),
  );
  assert.equal(releases, 1);
});

test("spawn defect emits error and settlement after creation", async () => {
  const recording = createRecordingSink();
  const backend: SubagentBackend = {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () => Effect.die(new Error("fixture backend spawn defect")),
  };
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      await assert.rejects(
        runTool(runtime, manager.spawn("pi", task("defective spawn"))),
        /fixture backend spawn defect/,
      );
      assert.deepEqual(
        recording.events.map((event) => event.kind),
        ["agent.created", "agent.error", "agent.settled"],
      );
      assert.match(
        String((recording.events[1]?.payload as { message?: string }).message),
        /fixture backend spawn defect/,
      );
    },
    registryLayer([backend]),
  );
});

test("durable identity and creation event precede backend availability and spawn", async () => {
  const order: string[] = [];
  const recording = createRecordingSink();
  const sink: ObservabilitySink = {
    emit: (event) => {
      order.push(`emit:${event.kind}`);
      recording.emit(event);
    },
    flush: (budgetMs) => recording.flush(budgetMs),
  };
  const delegate = makeStubBackend({
    backend: "codex",
    defaultModelLabel: "codex/test",
    contextWindow: 10_000,
    toolName: "shell",
    cadenceMs: 10,
  });
  let backendTask: SpawnTask | undefined;
  const backend: SubagentBackend = {
    ...delegate,
    available: Effect.sync(() => {
      order.push("available");
      return true;
    }),
    spawn: (spawnTask) => {
      order.push("spawn");
      backendTask = spawnTask;
      assert.ok(spawnTask.identity);
      return delegate.spawn(spawnTask);
    },
  };

  await withObservedManager(
    sink,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("codex", {
          ...task("identity before backend"),
          parent: {
            ...parent,
            traceId: "pi-session:root-session",
            rootRunId: "pi-run:root-session",
          },
        }),
      );
      assert.deepEqual(order.slice(0, 3), [
        "emit:agent.created",
        "available",
        "spawn",
      ]);
      assert.ok(backendTask?.identity);
      assert.equal(backendTask.identity, started.identity);
      assert.equal(Object.isFrozen(backendTask.identity), true);
      assert.equal(Object.isFrozen(backendTask), true);
      assert.equal(isStandaloneRunId(started.identity.runId), true);
      assert.equal(isAgentId(started.identity.agentId), true);
      assert.equal(isTurnId(started.identity.turnId), true);
      assert.equal(started.identity.traceId, "pi-session:root-session");
      assert.equal(started.identity.parentRunId, "pi-run:root-session");
      assert.match(started.id, /^sa-/);
      await runTool(runtime, manager.cancel([started.id]));
    },
    registryLayer([backend]),
  );
});

test("agent event envelope bounds opaque parent IDs", async () => {
  const recording = createRecordingSink();
  const backend = makeStubBackend({
    backend: "codex",
    defaultModelLabel: "codex/test",
    contextWindow: 10_000,
    toolName: "shell",
    cadenceMs: 10,
  });
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("codex", {
          ...task("bounded parent ids"),
          parent: {
            ...parent,
            traceId: `pi-session:${"x".repeat(10_000)}`,
            rootRunId: `pi-run:${"y".repeat(10_000)}`,
          },
        }),
      );
      const created = recording.events[0]!;
      assert.ok(
        Buffer.byteLength(JSON.stringify(created.ids.traceId), "utf8") <=
          METADATA_TEXT_MAX_BYTES,
      );
      assert.ok(
        Buffer.byteLength(JSON.stringify(created.ids.parentRunId), "utf8") <=
          METADATA_TEXT_MAX_BYTES,
      );
      assert.deepEqual(created.capture.truncatedFields, [
        "ids.traceId",
        "ids.parentRunId",
      ]);
      await runTool(runtime, manager.cancel([started.id]));
    },
    registryLayer([backend]),
  );
});

test("parallel spawn reservations mint unique run, agent, and turn identities", async () => {
  const recording = createRecordingSink();
  const captured: SpawnTask[] = [];
  const delegate = makeStubBackend({
    backend: "codex",
    defaultModelLabel: "codex/test",
    contextWindow: 10_000,
    toolName: "shell",
    cadenceMs: 30,
  });
  const backend: SubagentBackend = {
    ...delegate,
    spawn: (spawnTask) => {
      captured.push(spawnTask);
      return delegate.spawn(spawnTask);
    },
  };
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const snapshots = await runTool(
        runtime,
        Effect.forEach(
          [1, 2, 3, 4],
          (index) => manager.spawn("codex", task(`parallel-${index}`)),
          { concurrency: "unbounded" },
        ),
      );
      assert.equal(captured.length, 4);
      assert.equal(
        new Set(snapshots.map((snapshot) => snapshot.identity.runId)).size,
        4,
      );
      assert.equal(
        new Set(snapshots.map((snapshot) => snapshot.identity.agentId)).size,
        4,
      );
      assert.equal(
        new Set(snapshots.map((snapshot) => snapshot.identity.turnId)).size,
        4,
      );
      assert.equal(
        new Set(snapshots.map((snapshot) => snapshot.identity.traceId)).size,
        4,
      );
      assert.equal(
        new Set(snapshots.map((snapshot) => snapshot.identity.parentRunId))
          .size,
        4,
      );
      assert.ok(
        snapshots.every(
          (snapshot) =>
            snapshot.identity.traceId !== "pi-session:unknown" &&
            snapshot.identity.traceId.replace("pi-session:", "pi-run:") ===
              snapshot.identity.parentRunId,
        ),
      );
      assert.ok(
        captured.every((spawnTask) => spawnTask.identity !== undefined),
      );
      await runTool(
        runtime,
        manager.cancel(snapshots.map((snapshot) => snapshot.id)),
      );
    },
    registryLayer([backend]),
  );
});

test("follow-up preserves agent identity and attributes its user event to the new turn", async () => {
  const recording = createRecordingSink();
  const backend = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/test",
    contextWindow: 10_000,
    toolName: "Bash",
    cadenceMs: 2,
  });
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("claude", task("identity turn one")),
      );
      await runTool(runtime, manager.waitFor([started.id]));
      const first = { ...manager.view.get(started.id)!.identity };

      await runTool(runtime, manager.send(started.id, "identity turn two"));
      await runTool(runtime, manager.waitFor([started.id]));
      const second = manager.view.get(started.id)!.identity;
      assert.equal(second.runId, first.runId);
      assert.equal(second.agentId, first.agentId);
      assert.notEqual(second.turnId, first.turnId);
      assert.equal(Object.isFrozen(second), true);

      const starts = recording.events.filter(
        (event) => event.kind === "agent.run_started",
      );
      const users = recording.events.filter(
        (event) =>
          event.kind === "agent.message" &&
          (event.payload as { messageKind?: string }).messageKind === "user",
      );
      assert.equal(starts.length, 2);
      assert.equal(users.length, 2);
      assert.deepEqual(
        starts.map((event) => event.ids.turnId),
        [first.turnId, second.turnId],
      );
      assert.deepEqual(
        users.map((event) => event.ids.turnId),
        [first.turnId, second.turnId],
      );
      const settlements = recording.events.filter(
        (event) => event.kind === "agent.settled",
      );
      assert.deepEqual(
        settlements.map((event) => (event.payload as { turns: number }).turns),
        [1, 2],
      );
      assert.equal(manager.view.get(started.id)?.turns, 4);
      assert.equal(recording.events[0]?.kind, "agent.created");
      assert.equal(recording.events.at(-1)?.kind, "agent.settled");
      assert.ok(
        recording.events.every(
          (event) => !["AssistantDelta", "ToolUpdate"].includes(event.kind),
        ),
      );
      assert.equal(
        JSON.stringify(recording.events).includes("identity turn one"),
        false,
      );
    },
    registryLayer([backend]),
  );
});

test("live steering retains the current turn until another native boundary", async () => {
  const recording = createRecordingSink();
  const backend = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/test",
    contextWindow: 10_000,
    toolName: "Bash",
    cadenceMs: 10,
  });
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("claude", task("live steering")),
      );
      const currentTurn = started.identity.turnId;
      await runTool(runtime, manager.send(started.id, "queued while live"));
      assert.equal(manager.view.get(started.id)?.identity.turnId, currentTurn);
      while (
        recording.events.filter((event) => event.kind === "agent.run_started")
          .length < 2
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.notEqual(
        manager.view.get(started.id)?.identity.turnId,
        currentTurn,
      );
      await runTool(runtime, manager.cancel([started.id]));
    },
    registryLayer([backend]),
  );
});

test("reopening native history creates a new durable run and agent identity", async () => {
  const backend = makeStubBackend({
    backend: "codex",
    defaultModelLabel: "codex/test",
    contextWindow: 10_000,
    toolName: "shell",
    cadenceMs: 2,
  });
  const firstSink = createRecordingSink();
  let firstIdentity: ReturnType<typeof task>["identity"];
  await withObservedManager(
    firstSink,
    async (manager, runtime) => {
      const first = await runTool(
        runtime,
        manager.spawn("codex", {
          ...task("original role run"),
          role: "durable-reviewer",
        }),
      );
      firstIdentity = first.identity;
      await runTool(runtime, manager.waitFor([first.id]));
    },
    registryLayer([backend]),
  );

  const secondSink = createRecordingSink();
  await withObservedManager(
    secondSink,
    async (manager, runtime) => {
      const reopened = await runTool(
        runtime,
        manager.resumeRole("codex", {
          ...task("continue native history"),
          role: "durable-reviewer",
          resume: { nativeSessionId: "saved-native-history" },
        }),
      );
      assert.equal(reopened.reopened, true);
      assert.notEqual(reopened.snapshot.identity.runId, firstIdentity?.runId);
      assert.notEqual(
        reopened.snapshot.identity.agentId,
        firstIdentity?.agentId,
      );
      assert.equal(
        reopened.snapshot.meta.nativeSessionId,
        "saved-native-history",
      );
      await runTool(runtime, manager.waitFor([reopened.snapshot.id]));
    },
    registryLayer([backend]),
  );
});

test("manager isolates a sink that throws on every lifecycle event", async () => {
  let settlements = 0;
  let releases = 0;
  const hostile: ObservabilitySink = {
    emit: () => {
      throw new Error("hostile sink");
    },
    flush: async () => {
      throw new Error("hostile flush");
    },
  };
  const backend = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/test",
    contextWindow: 10_000,
    toolName: "Bash",
    cadenceMs: 10,
  });
  await withObservedManager(
    hostile,
    async (manager, runtime) => {
      manager.view.setOnSettled(() => settlements++);
      const started = await runTool(
        runtime,
        manager.spawn("claude", {
          ...task("hostile sink lifecycle"),
          roleLease: { release: () => releases++ },
        }),
      );
      const report = await runTool(runtime, manager.cancel([started.id]));
      assert.equal(report[0]?.cancelled, true);
      await runTool(runtime, manager.waitFor([started.id]));
      assert.equal(manager.view.get(started.id)?.status, "error");
      assert.equal(settlements, 1);
    },
    registryLayer([backend]),
  );
  assert.equal(releases, 1);
});

test("forced abort reports the same terminal reason in snapshot and event", async () => {
  const recording = createRecordingSink();
  const backend: SubagentBackend = {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.succeed({
        meta: Effect.succeed({ backend: "pi" as const }),
        events: Stream.concat(
          Stream.fromIterable([
            { _tag: "UserMessage" as const, text: "force abort" },
            { _tag: "RunStarted" as const },
          ]),
          Stream.never,
        ),
        send: () => Effect.void,
        interrupt: Effect.fail(
          "forced interrupt failure",
        ) as unknown as Effect.Effect<void>,
      }),
  };
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("pi", task("force abort")),
      );
      while (
        !recording.events.some((event) => event.kind === "agent.run_started")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await runTool(runtime, manager.cancel([started.id]));
      const expected = "Abort deadline exceeded; session was force-disposed";
      assert.equal(manager.view.get(started.id)?.errorText, expected);
      const settled = recording.events.findLast(
        (event) => event.kind === "agent.settled",
      );
      assert.equal((settled?.payload as { error?: string }).error, expected);
      assert.equal(settled?.capture.contentMode, "rich");
    },
    registryLayer([backend]),
  );
});

test("workflow-origin manager work emits only the shared agent vocabulary", async () => {
  const recording = createRecordingSink();
  const backend = makeStubBackend({
    backend: "codex",
    defaultModelLabel: "codex/test",
    contextWindow: 10_000,
    toolName: "shell",
    cadenceMs: 2,
  });
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("codex", {
          ...task("workflow-owned manager work"),
          origin: "workflow",
          workflowRunId: "wf_abcdef123456",
          workflowAgentIndex: 1,
        }),
      );
      assert.equal(started.identity.runId, "wf_abcdef123456");
      await runTool(runtime, manager.waitFor([started.id]));
      assert.ok(recording.events.length > 0);
      assert.ok(
        recording.events.every((event) => event.kind.startsWith("agent.")),
      );
      assert.equal(
        recording.events.some((event) => event.kind.startsWith("workflow.")),
        false,
      );
    },
    registryLayer([backend]),
  );
});

test("manager observability bounds backend diagnostics without losing settlement", async () => {
  const hugeError = `diagnostic:${"😀".repeat(40_000)}`;
  const backend: SubagentBackend = {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.succeed({
        meta: Effect.succeed({ backend: "pi" as const }),
        events: Stream.fromIterable([
          { _tag: "RunStarted" as const },
          { _tag: "BackendError" as const, message: hugeError },
          {
            _tag: "RunSettled" as const,
            outcome: {
              _tag: "Failed" as const,
              errorText: "backend failed after diagnostic",
              schemaError: 'invalid JSON near "apiKey": "sk-live-fragment"',
            },
          },
        ]),
        send: () => Effect.void,
        interrupt: Effect.void,
      }),
  };
  const recording = createRecordingSink();
  await withObservedManager(
    recording,
    async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.spawn("pi", task("bounded diagnostic")),
      );
      await runTool(runtime, manager.waitFor([started.id]));
      assert.equal(manager.view.get(started.id)?.status, "error");
      const diagnostic = recording.events.find(
        (event) =>
          event.kind === "agent.error" &&
          (event.payload as { stage?: string }).stage === "backend",
      );
      assert.ok(diagnostic);
      assert.equal(diagnostic.capture.contentMode, "rich");
      assert.equal(diagnostic.capture.truncated, true);
      assert.deepEqual(diagnostic.capture.truncatedFields, ["payload.message"]);
      assert.ok(JSON.stringify(diagnostic).length < hugeError.length);
      const settled = recording.events.at(-1);
      assert.equal(settled?.kind, "agent.settled");
      assert.equal(settled?.capture.contentMode, "rich");
      assert.match(
        String((settled?.payload as { schemaError?: string }).schemaError),
        /sk-live-fragment/,
      );
    },
    registryLayer([backend]),
  );
});
