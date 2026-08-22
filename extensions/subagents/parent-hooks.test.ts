import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PendingObservabilityEvent } from "../shared/observability/events.ts";
import { observabilityPaths } from "../shared/observability/home.mjs";
import { normalizePolicyConfig } from "../shared/observability/policy.mjs";
import { mintProducerId } from "../shared/observability/ids.ts";
import { createParentHookObserver } from "./src/parent-hooks.ts";
import type { ProducerObservabilitySink } from "./src/producer-sink.ts";

function harness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

async function emit(
  handlers: Map<string, Array<(...args: any[]) => unknown>>,
  name: string,
  event: unknown,
  ctx: ExtensionContext,
) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

test("root parent hooks emit finalized lifecycle/message/tool/turn facts only", async (t) => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-parent-hooks-d2-"),
  );
  fs.chmodSync(agentDir, 0o700);
  const project = path.join(agentDir, "project");
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const paths = observabilityPaths(agentDir);
  const config = normalizePolicyConfig({
    version: 1,
    capture: "rich",
    autostart: false,
    defaults: { enabled: true, contentMode: "rich" },
  });
  const events: PendingObservabilityEvent<string>[] = [];
  const diagnostics: string[] = [];
  const sink: ProducerObservabilitySink = {
    producerId: mintProducerId(),
    paths,
    config,
    closed: false,
    stats: {
      producerId: mintProducerId(),
      producerSeq: 0,
      accepted: 0,
      normalizedDropped: 0,
      coalesced: 0,
      pressureDropped: 0,
      pressureSpooled: 0,
      queueEvents: 0,
      queueBytes: 0,
      healthTransitions: 0,
      reasons: {},
    },
    contentModeFor: () => "rich",
    recordDiagnostic: (reason) => diagnostics.push(reason),
    emit: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
  };
  const { pi, handlers } = harness();
  const observer = createParentHookObserver({ getSink: () => sink });
  observer.register(pi);
  const ctx = {
    cwd: project,
    model: { provider: "fixture", id: "model" },
    thinkingLevel: "high",
    sessionManager: { getSessionId: () => "root-session" },
    getContextUsage: () => ({ tokens: 123, contextWindow: 10_000 }),
  } as unknown as ExtensionContext;

  observer.sessionStart({ reason: "startup" }, ctx);
  await emit(
    handlers,
    "before_agent_start",
    { prompt: "private user prompt", images: [] },
    ctx,
  );
  await emit(handlers, "turn_start", { turnIndex: 0, timestamp: 10 }, ctx);
  await emit(
    handlers,
    "message_end",
    {
      message: {
        role: "assistant",
        provider: "fixture",
        model: "model",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "final thinking" },
          { type: "text", text: "final answer" },
        ],
      },
    },
    ctx,
  );
  await emit(
    handlers,
    "tool_execution_start",
    { toolCallId: "call-1", toolName: "read", args: { path: "README.md" } },
    ctx,
  );
  await emit(
    handlers,
    "tool_execution_update",
    { toolCallId: "call-1", partialResult: "streaming secret" },
    ctx,
  );
  await emit(
    handlers,
    "tool_execution_end",
    {
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "final tool result" }] },
      isError: false,
    },
    ctx,
  );
  await emit(
    handlers,
    "turn_end",
    { turnIndex: 0, message: { stopReason: "stop" }, toolResults: [{}] },
    ctx,
  );
  await emit(
    handlers,
    "session_compact",
    {
      reason: "manual",
      willRetry: false,
      fromExtension: false,
      compactionEntry: { tokensBefore: 9_000, summary: "not captured" },
    },
    ctx,
  );
  observer.sessionShutdown({ reason: "quit" }, ctx);

  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "run.started",
      "message.user",
      "turn.started",
      "message.assistant",
      "tool.started",
      "tool.finished",
      "turn.settled",
      "session.compacted",
      "run.settled",
    ],
  );
  assert.equal(handlers.has("message_update"), false);
  assert.equal(handlers.has("tool_execution_update"), false);
  assert.equal(handlers.has("context"), false);
  const assistant = events.find((event) => event.kind === "message.assistant");
  assert.equal(
    (assistant?.payload as { content?: string }).content,
    "final answer",
  );
  assert.equal(
    (assistant?.payload as { thinking?: string }).thinking,
    "final thinking",
  );
  assert.equal(
    (events.at(-1)?.payload as { status?: string }).status,
    "completed",
  );
  assert.equal(diagnostics.length, 0);
});

test("parent hook faults and protected companion tool paths are swallowed", async (t) => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-parent-fault-d2-"),
  );
  fs.chmodSync(agentDir, 0o700);
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const paths = observabilityPaths(agentDir);
  const config = normalizePolicyConfig({ version: 1, capture: "metadata" });
  let diagnostics = 0;
  let throws = false;
  const sink = {
    producerId: mintProducerId(),
    paths,
    config,
    closed: false,
    contentModeFor: () => "metadata",
    recordDiagnostic: () => diagnostics++,
    emit() {
      if (throws) throw new Error("sink-fault");
    },
    flush: async () => {},
    close: async () => {},
    stats: {} as ProducerObservabilitySink["stats"],
  } satisfies ProducerObservabilitySink;
  const { pi, handlers } = harness();
  const observer = createParentHookObserver({ getSink: () => sink });
  observer.register(pi);
  const ctx = {
    cwd: agentDir,
    sessionManager: { getSessionId: () => "fault-session" },
  } as unknown as ExtensionContext;
  observer.sessionStart({}, ctx);

  await assert.doesNotReject(
    emit(
      handlers,
      "tool_execution_start",
      {
        toolCallId: "protected",
        toolName: "read",
        args: { path: paths.ingestToken },
      },
      ctx,
    ),
  );
  throws = true;
  await assert.doesNotReject(
    emit(
      handlers,
      "before_agent_start",
      { prompt: "still runs", images: [] },
      ctx,
    ),
  );
  assert.equal(diagnostics, 1);
});
