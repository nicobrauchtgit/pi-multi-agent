import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  currentProcessService,
  resetProcessServiceRegistryForTests,
} from "../shared/service-registry.ts";
import subagents from "./index.ts";

interface ExtensionHarness {
  readonly handlers: Map<string, Array<(...args: any[]) => unknown>>;
  readonly tools: Map<
    string,
    { execute: (...args: any[]) => Promise<unknown> }
  >;
}

function extensionHarness(): ExtensionHarness {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<unknown> }
  >();
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool(tool: {
      name: string;
      execute: (...args: any[]) => Promise<unknown>;
    }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    getThinkingLevel() {
      return "off";
    },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  subagents(pi);
  return { handlers, tools };
}

function context(): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "index-lifecycle-test",
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

test("duplicate providers diagnose cleanly and shutdown cannot recreate a service", async () => {
  resetProcessServiceRegistryForTests();
  const first = extensionHarness();
  const duplicate = extensionHarness();
  const ctx = context();
  try {
    await emit(first, "session_start", ctx);
    const owner = currentProcessService();
    assert.ok(owner?.isCurrent());

    // A duplicate settings entry must not reject the session_start hook or
    // replace the already-live owner.
    await emit(duplicate, "session_start", ctx);
    assert.equal(currentProcessService(), owner);
    await assert.rejects(
      duplicate.tools.get("subagent_list")!.execute(),
      /service initialization failed.*already exists/i,
    );

    await emit(duplicate, "session_shutdown");
    assert.equal(currentProcessService(), owner);
    await emit(first, "session_shutdown");
    assert.equal(currentProcessService(), undefined);

    await assert.rejects(
      first.tools.get("subagent_list")!.execute(),
      /subagent session is not active/i,
    );
    assert.equal(currentProcessService(), undefined);
  } finally {
    resetProcessServiceRegistryForTests();
  }
});
