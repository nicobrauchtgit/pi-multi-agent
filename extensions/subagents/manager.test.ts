/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus a
 * deliberately failing pi fixture for spawn-cleanup coverage.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
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
        workflowRunId: "workflow-run-1",
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
    assert.equal(workflow.workflowRunId, "workflow-run-1");
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
        workflowRunId: "workflow-run-structured",
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
    assert.equal(settled.workflowRunId, "workflow-run-structured");
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
        workflowRunId: "workflow-run-cap",
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
