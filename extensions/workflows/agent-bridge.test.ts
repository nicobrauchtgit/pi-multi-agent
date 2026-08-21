import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { NOOP_OBSERVABILITY_SINK } from "../shared/observability/sink.ts";
import type { ProcessServiceHandle } from "../shared/service-registry.ts";
import {
  BackendRegistry,
  type SubagentBackend,
} from "../subagents/src/backend.ts";
import { makeStubBackend } from "../subagents/src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentSnapshot,
} from "../subagents/src/domain.ts";
import {
  SubagentManager,
  SubagentManagerWithSink,
  type SubagentManagerShape,
} from "../subagents/src/manager.ts";
import { ObservabilitySinkService } from "../shared/observability/sink.ts";
import type { SubagentRuntime } from "../subagents/src/runtime.ts";
import {
  applyManagerSnapshotToAgentRecord,
  executeManagerWorkflowAgent,
  transcriptFromManagerSnapshot,
} from "./agent-bridge.ts";
import { emptyUsage, type AgentRecord } from "./model.ts";

const schema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    turn: { type: "number" },
  },
  required: ["prompt", "turn"],
  additionalProperties: false,
};

const parent: ParentContext = {
  parentCwd: tmpdir(),
  projectTrusted: false,
  inheritedModel: { provider: "fixture", id: "pi-model" },
  inheritedThinkingLevel: "medium",
  modelRegistry: {
    find(provider: string, id: string) {
      return provider === "fixture" && id === "pi-model"
        ? {
            provider,
            id,
            name: id,
            api: "openai-responses",
            baseUrl: "https://example.invalid",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 8_000,
          }
        : undefined;
    },
    getAll() {
      return [];
    },
  } as unknown as NonNullable<ParentContext["modelRegistry"]>,
};

function registry(backends?: SubagentBackend[]) {
  const values =
    backends ??
    ([
      makeStubBackend({
        backend: "pi",
        defaultModelLabel: "fixture/pi",
        contextWindow: 100_000,
        toolName: "bash",
        cadenceMs: 1,
      }),
      makeStubBackend({
        backend: "claude",
        defaultModelLabel: "claude/sonnet",
        contextWindow: 200_000,
        toolName: "Bash",
        cadenceMs: 1,
      }),
      makeStubBackend({
        backend: "codex",
        defaultModelLabel: "codex/gpt",
        contextWindow: 272_000,
        toolName: "shell",
        cadenceMs: 1,
      }),
    ] satisfies SubagentBackend[]);
  return Layer.succeed(
    BackendRegistry,
    new Map(values.map((backend) => [backend.name, backend])),
  );
}

function runtime(backends?: SubagentBackend[]) {
  return ManagedRuntime.make(
    SubagentManagerWithSink.pipe(
      Layer.provide(registry(backends)),
      Layer.provide(
        Layer.succeed(ObservabilitySinkService, NOOP_OBSERVABILITY_SINK),
      ),
    ),
  );
}

function service(
  managed: SubagentRuntime,
  manager: SubagentManagerShape,
  lifecycle: { current: boolean; shutdown: AbortController } = {
    current: true,
    shutdown: new AbortController(),
  },
): ProcessServiceHandle<SubagentRuntime, SubagentManagerShape> {
  return {
    version: 1,
    epoch: 1,
    ownerToken: "test-owner",
    runtime: managed,
    manager: Promise.resolve(manager),
    sink: NOOP_OBSERVABILITY_SINK,
    shutdownSignal: lifecycle.shutdown.signal,
    isCurrent: () => lifecycle.current && !lifecycle.shutdown.signal.aborted,
  };
}

function record(index = 1): AgentRecord {
  return {
    index,
    label: `agent-${index}`,
    phase: "test",
    state: "running",
    startedAt: Date.now(),
    preview: "",
    usage: emptyUsage(),
    transcript: [],
  };
}

async function withBridge(
  run: (options: {
    manager: SubagentManagerShape;
    managed: SubagentRuntime;
    service: ProcessServiceHandle<SubagentRuntime, SubagentManagerShape>;
  }) => Promise<void>,
  backends?: SubagentBackend[],
) {
  const managed = runtime(backends) as SubagentRuntime;
  try {
    const manager = await managed.runPromise(SubagentManager);
    await run({ manager, managed, service: service(managed, manager) });
  } finally {
    await managed.dispose();
  }
}

function execute(
  processService: ProcessServiceHandle<SubagentRuntime, SubagentManagerShape>,
  agentRecord: AgentRecord,
  options: Record<string, unknown> = {},
  signal = new AbortController().signal,
  responseStallMs?: number,
) {
  return executeManagerWorkflowAgent("return structured data", options, {
    service: processService,
    runId: "wf_abcdef123456",
    cwd: tmpdir(),
    parent,
    record: agentRecord,
    signal,
    onUpdate: () => {},
    responseStallMs,
  });
}

test("Pi, Claude, and Codex workflow calls return structured manager results", async () => {
  await withBridge(async ({ service: processService }) => {
    for (const [index, harness] of ["pi", "claude", "codex"].entries()) {
      const agentRecord = record(index + 1);
      const result = await execute(processService, agentRecord, {
        harness,
        schema,
        effort: "high",
      });
      assert.equal(result.ok, true, `${harness}: ${result.error}`);
      assert.equal(agentRecord.harness, harness);
      assert.match(agentRecord.displayId ?? "", /^sa-/);
      assert.ok(agentRecord.agentId?.startsWith("agent_"));
      assert.equal("structured" in agentRecord, false);
      assert.deepEqual(result.structured, {
        prompt: "return structured data",
        turn: 1,
      });
      assert.ok(agentRecord.transcript.some((entry) => entry.role === "tool"));
      assert.ok(agentRecord.usage.input > 0);
    }
  });
});

test("harness model, provider migration shim, and effort map into SpawnTask", async () => {
  const seen: Array<{ backend: BackendName; task: SpawnTask }> = [];
  const capture = (name: BackendName): SubagentBackend => ({
    name,
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (spawnTask) => {
      seen.push({ backend: name, task: spawnTask });
      return Effect.succeed({
        meta: Effect.succeed({
          backend: name,
          modelLabel: spawnTask.model ?? `${name}/default`,
        }),
        events: Stream.fromIterable([
          { _tag: "RunStarted" as const },
          {
            _tag: "AssistantMessage" as const,
            parts: [{ type: "text" as const, text: "ok" }],
          },
          {
            _tag: "RunSettled" as const,
            outcome: { _tag: "Completed" as const, finalText: "ok" },
          },
        ]),
        send: () => Effect.void,
        interrupt: Effect.void,
      });
    },
  });
  await withBridge(
    async ({ service: processService }) => {
      assert.equal(
        (
          await execute(processService, record(1), {
            harness: "pi",
            provider: "fixture",
            model: "pi-model",
            effort: "xhigh",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await execute(processService, record(2), {
            harness: "claude",
            model: "opus",
            effort: "medium",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await execute(processService, record(3), {
            harness: "codex",
            model: "gpt-test",
            effort: "low",
          })
        ).ok,
        true,
      );
    },
    [capture("pi"), capture("claude"), capture("codex")],
  );
  assert.ok(
    seen.every(
      ({ task }) =>
        task.identity?.origin === "workflow" &&
        task.autoDeliver === false &&
        task.role === undefined &&
        task.parent.projectTrusted === parent.projectTrusted &&
        task.parent.modelRegistry === parent.modelRegistry &&
        task.workflowRunId === "wf_abcdef123456",
    ),
  );
  assert.deepEqual(
    seen.map(({ backend, task }) => [
      backend,
      task.model,
      task.reasoningEffort,
    ]),
    [
      ["pi", "fixture/pi-model", "xhigh"],
      ["claude", "opus", "medium"],
      ["codex", "gpt-test", "low"],
    ],
  );
});

test("invalid harness/provider/effort/schema errors never throw into scripts", async () => {
  await withBridge(async ({ manager, service: processService }) => {
    for (const options of [
      { harness: "other" },
      { harness: "claude", provider: "fixture", model: "pi-model" },
      { harness: "pi", effort: "impossible" },
      { harness: "pi", schema: { type: "string" } },
      {
        harness: "codex",
        schema: {
          type: "object",
          properties: { optional: { type: "string" } },
          additionalProperties: true,
        },
      },
    ]) {
      const result = await execute(processService, record(), options);
      assert.equal(result.ok, false);
      assert.ok(result.error);
    }
    assert.equal(manager.view.size(), 0);
  });
});

test("failed, schema-failed, and cancelled settlements remain isolated", async () => {
  await withBridge(async ({ service: processService }) => {
    const failedRecord = record(1);
    const failed = await executeManagerWorkflowAgent(
      "FAIL: requested",
      { harness: "claude" },
      {
        service: processService,
        runId: "wf_abcdef123456",
        cwd: tmpdir(),
        parent,
        record: failedRecord,
        signal: new AbortController().signal,
        onUpdate: () => {},
      },
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /task failed/);
    assert.equal(failed.structured, undefined);

    const schemaRecord = record(2);
    const schemaFailed = await executeManagerWorkflowAgent(
      "SCHEMA_FAIL: requested",
      { harness: "codex", schema },
      {
        service: processService,
        runId: "wf_abcdef123456",
        cwd: tmpdir(),
        parent,
        record: schemaRecord,
        signal: new AbortController().signal,
        onUpdate: () => {},
      },
    );
    assert.equal(schemaFailed.ok, false);
    assert.match(schemaFailed.error ?? "", /schema/i);
    assert.equal(schemaFailed.structured, undefined);

    const abort = new AbortController();
    const cancelled = execute(processService, record(3), {}, abort.signal);
    abort.abort();
    assert.deepEqual(await cancelled, {
      ok: false,
      output: "",
      error: "Agent was aborted",
    });
  });
});

test("interrupted settlements preserve the manager's terminal reason", async () => {
  const interrupted: SubagentBackend = {
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
          {
            _tag: "RunSettled" as const,
            outcome: {
              _tag: "Interrupted" as const,
              errorText: "Abort deadline exceeded; session was force-disposed",
            },
          },
        ]),
        send: () => Effect.void,
        interrupt: Effect.void,
      }),
  };
  await withBridge(
    async ({ service: processService }) => {
      const result = await execute(processService, record());
      assert.equal(result.ok, false);
      assert.equal(
        result.error,
        "Abort deadline exceeded; session was force-disposed",
      );
    },
    [interrupted],
  );
});

test("stall watchdog cancels manager work after spawn, not admission", async () => {
  const silent: SubagentBackend = {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<any>();
        Queue.offerUnsafe(events, { _tag: "RunStarted" });
        return {
          meta: Effect.succeed({ backend: "pi" as const }),
          events: Stream.fromQueue(events),
          send: () => Effect.void,
          interrupt: Effect.void,
        };
      }),
  };
  await withBridge(
    async ({ service: processService }) => {
      const result = await execute(processService, record(), {}, undefined, 10);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /no assistant response event.*stalled/i);
    },
    [silent],
  );
});

test("service epoch loss aborts native work and returns a reload error", async () => {
  await withBridge(async ({ manager, managed }) => {
    const lifecycle = { current: true, shutdown: new AbortController() };
    const processService = service(managed, manager, lifecycle);
    const agentRecord = record();
    const pending = execute(processService, agentRecord);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!agentRecord.displayId) return;
        clearInterval(timer);
        resolve();
      }, 1);
    });
    lifecycle.current = false;
    lifecycle.shutdown.abort(new Error("reload"));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error, "Subagent service was reloaded");
  });
});

test("snapshot adapter preserves normalized timing, usage, preview, and bounds", () => {
  const snapshot = {
    id: "sa-9",
    identity: {
      runId: "wf_abcdef123456",
      agentId: "agent_11111111-1111-4111-8111-111111111111",
      turnId: "turn_11111111-1111-4111-8111-111111111111",
      origin: "workflow",
      parentRunId: "pi-run:test",
      traceId: "pi-session:test",
    },
    origin: "workflow",
    autoDeliver: false,
    workflowRunId: "wf_abcdef123456",
    workflowAgentIndex: 1,
    backend: "codex",
    title: "adapter",
    prompt: "test",
    cwd: tmpdir(),
    status: "done",
    createdAt: 100,
    settledAt: 200,
    structured: { findings: ["ok"] },
    meta: { backend: "codex", modelLabel: "gpt-test", contextWindow: 272_000 },
    usage: {
      tokens: 50_000,
      contextWindow: 272_000,
      inputTokens: 40_000,
      outputTokens: 10_000,
      cacheReadTokens: 5_000,
      costUsd: 0.5,
    },
    transcript: [
      {
        kind: "assistant",
        timestamp: 110,
        parts: [
          {
            type: "toolCall",
            toolId: "tool-1",
            name: "read",
            argsPreview: '{"path":"x"}',
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: "tool-1",
        name: "read",
        isError: false,
        outputPreview: "ok",
        timestamp: 140,
        startedAt: 120,
        finishedAt: 140,
        durationMs: 20,
      },
    ],
    liveTools: [],
    queued: [],
    finalText: "x".repeat(2_000),
    turns: 1,
  } as unknown as SubagentSnapshot;
  const agentRecord = record();
  applyManagerSnapshotToAgentRecord(agentRecord, snapshot);
  assert.equal(agentRecord.displayId, "sa-9");
  assert.equal(agentRecord.harness, "codex");
  assert.equal(agentRecord.model, "gpt-test");
  assert.equal(agentRecord.contextWindow, 272_000);
  assert.equal(agentRecord.usage.contextTokens, 50_000);
  assert.equal(agentRecord.usage.input, 40_000);
  assert.equal(Buffer.byteLength(agentRecord.preview, "utf8"), 1_024);
  const transcript = transcriptFromManagerSnapshot(snapshot);
  assert.deepEqual(
    transcript.map(({ role, toolCallId, durationMs }) => ({
      role,
      toolCallId,
      durationMs,
    })),
    [
      { role: "tool", toolCallId: "tool-1", durationMs: 20 },
      { role: "toolResult", toolCallId: "tool-1", durationMs: 20 },
    ],
  );
});
