import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { NOOP_OBSERVABILITY_SINK } from "../shared/observability/sink.ts";
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

test("observability spool initialization failure does not disable subagent tools", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-index-sink-failure-"),
  );
  fs.chmodSync(agentDir, 0o700);
  const observability = path.join(agentDir, "multi-agent", "observability");
  const spool = path.join(observability, "spool");
  fs.mkdirSync(path.join(spool, "quarantine"), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(observability, "logs"), { mode: 0o700 });
  fs.writeFileSync(
    path.join(observability, "config.json"),
    `${JSON.stringify({
      version: 1,
      capture: "metadata",
      autostart: false,
      defaults: { enabled: true, contentMode: "metadata" },
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(spool, 0o500);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    try {
      fs.chmodSync(spool, 0o700);
    } catch {
      // Temp cleanup is already best effort.
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  resetProcessServiceRegistryForTests();
  const harness = extensionHarness();
  try {
    await emit(harness, "session_start", context());
    const owner = currentProcessService();
    assert.ok(owner);
    assert.equal(owner.sink, NOOP_OBSERVABILITY_SINK);
    const listed = await harness.tools.get("subagent_list")!.execute();
    assert.ok(listed);
    await assert.rejects(
      harness.tools.get("subagent_spawn")!.execute(
        "call",
        {
          prompt: "must not start",
          name: "protected cwd",
          harness: "pi",
          working_dir: agentDir,
        },
        undefined,
        undefined,
        context(),
      ),
      /working_dir.*protected parent observability state/i,
    );
    assert.equal(fs.statSync(spool).mode & 0o777, 0o500);
    await emit(harness, "session_shutdown");
  } finally {
    resetProcessServiceRegistryForTests();
  }
});

test("duplicate providers diagnose cleanly and shutdown cannot recreate a service", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-index-lifecycle-"),
  );
  fs.chmodSync(agentDir, 0o700);
  const observability = path.join(agentDir, "multi-agent", "observability");
  fs.mkdirSync(observability, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(observability, "config.json"),
    `${JSON.stringify({ version: 1, capture: "off", autostart: false })}\n`,
    { mode: 0o600 },
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  resetProcessServiceRegistryForTests();
  const first = extensionHarness();
  const duplicate = extensionHarness();
  const ctx = context();
  try {
    await emit(first, "session_start", ctx);
    const owner = currentProcessService();
    assert.ok(owner);
    assert.equal(owner.isCurrent(), true);
    assert.equal(owner.sink, NOOP_OBSERVABILITY_SINK);
    assert.equal(fs.existsSync(path.join(observability, "daemon.json")), false);
    const spoolEntries = fs.existsSync(path.join(observability, "spool"))
      ? fs.readdirSync(path.join(observability, "spool"))
      : [];
    assert.ok(spoolEntries.every((entry) => entry === "quarantine"));
    assert.equal(
      fs.existsSync(path.join(observability, "spool-state.json")),
      false,
    );

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
