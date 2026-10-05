import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
  disposeProcessService,
  provideProcessService,
  resetProcessServiceRegistryForTests,
} from "../shared/service-registry.ts";
import {
  BackendRegistry,
  type SubagentBackend,
} from "../subagents/src/backend.ts";
import {
  SubagentManager,
  SubagentManagerLive,
} from "../subagents/src/manager.ts";
import workflows from "./index.ts";
import type { WorkflowDetails } from "./model.ts";

interface ExtensionHarness {
  readonly handlers: Map<string, Array<(...args: any[]) => unknown>>;
  readonly tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
}

function extensionHarness(): ExtensionHarness {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool(tool: {
      name: string;
      execute: (...args: any[]) => Promise<any>;
    }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    getThinkingLevel() {
      return "off";
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  workflows(pi);
  return { handlers, tools };
}

function instantBackend(): SubagentBackend {
  return {
    name: "codex",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (task) =>
      Effect.succeed({
        meta: Effect.succeed({
          backend: "codex" as const,
          modelLabel: "codex/integration",
        }),
        events: Stream.fromIterable([
          { _tag: "UserMessage" as const, text: task.prompt },
          { _tag: "RunStarted" as const },
          {
            _tag: "AssistantMessage" as const,
            parts: [{ type: "text" as const, text: "integration-ok" }],
          },
          {
            _tag: "RunSettled" as const,
            outcome: {
              _tag: "Completed" as const,
              finalText: "integration-ok",
            },
          },
        ]),
        send: () => Effect.void,
        interrupt: Effect.void,
      }),
  };
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "workflow-extension-integration",
      getEntries: () => [],
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  } as unknown as ExtensionContext;
}

async function emit(
  harness: ExtensionHarness,
  event: "session_start" | "session_shutdown",
  ...args: unknown[]
) {
  for (const handler of harness.handlers.get(event) ?? []) {
    await handler({ type: event }, ...args);
  }
}

test("workflow tool acquires the process service and persists manager-backed work", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pi-workflow-extension-integration-"),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = path.join(directory, "agent");
  const project = path.join(directory, "project");
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetProcessServiceRegistryForTests();
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.succeed(BackendRegistry, new Map([["codex", instantBackend()]])),
      ),
    ),
  );
  const manager = await runtime.runPromise(SubagentManager);
  const service = provideProcessService({
    runtime,
    manager: Promise.resolve(manager),
  });
  const harness = extensionHarness();
  const ctx = context(project);
  try {
    await emit(harness, "session_start", ctx);
    const updates: WorkflowDetails[] = [];
    const result = await harness.tools.get("workflow")!.execute(
      "tool-call",
      {
        script:
          'phase("Integration"); return await agent("verify extension path", { harness: "codex", label: "integration" });',
        background: false,
      },
      new AbortController().signal,
      (update: { details?: WorkflowDetails }) => {
        if (update.details) updates.push(update.details);
      },
      ctx,
    );
    const details = result.details as WorkflowDetails;
    assert.equal(details.status, "completed");
    assert.equal(details.agents.length, 1);
    assert.equal(details.agents[0]?.harness, "codex");
    assert.equal(details.agents[0]?.state, "done");
    assert.equal("structured" in details.agents[0]!, false);
    assert.ok(updates.length > 0);
    assert.equal(
      updates.every((update) =>
        update.agents.every((agent) => !("structured" in agent)),
      ),
      true,
    );

    const runDir = path.join(agentDir, "workflows", details.runId);
    assert.equal(existsSync(path.join(runDir, "workflow.json")), true);
    const artifact = JSON.parse(
      await readFile(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(artifact.status, "completed");
    assert.equal(artifact.agents[0]?.state, "done");

    await emit(harness, "session_shutdown");
  } finally {
    disposeProcessService(service.ownerToken, "Integration test finished");
    await runtime.runPromise(manager.disposeAll).catch(() => {});
    await runtime.dispose();
    resetProcessServiceRegistryForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});
