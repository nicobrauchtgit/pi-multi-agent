import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  acquireProcessService,
  disposeProcessService,
  provideProcessService,
  resetProcessServiceRegistryForTests,
} from "../shared/service-registry.ts";
import type { ParentContext } from "../subagents/src/domain.ts";
import {
  SubagentManager,
  type SubagentManagerShape,
} from "../subagents/src/manager.ts";
import {
  createSubagentRuntime,
  type SubagentRuntime,
} from "../subagents/src/runtime.ts";
import { executeManagerWorkflowAgent } from "./agent-bridge.ts";
import { persistWorkflowJson } from "./artifacts.ts";
import { emptyUsage, type AgentRecord, type WorkflowDetails } from "./model.ts";
import { runWorkflowSandbox } from "./sandbox.ts";

const live = process.env.RUN_LIVE_WORKFLOW_TESTS === "1";

async function liveContext() {
  const runtime = createSubagentRuntime();
  const manager = await runtime.runPromise(SubagentManager);
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const modelHint =
    process.env.PI_LIVE_WORKFLOW_MODEL ?? "github-copilot/gpt-5-mini";
  const slash = modelHint.indexOf("/");
  if (slash <= 0) throw new Error("PI_LIVE_WORKFLOW_MODEL must be provider/id");
  const provider = modelHint.slice(0, slash);
  const id = modelHint.slice(slash + 1);
  if (!modelRegistry.find(provider, id)) {
    throw new Error(`Configured live Pi model is unavailable: ${modelHint}`);
  }
  const parent: ParentContext = {
    parentCwd: process.cwd(),
    projectTrusted: false,
    inheritedModel: { provider, id },
    inheritedThinkingLevel: "off",
    modelRegistry,
  };
  resetProcessServiceRegistryForTests();
  provideProcessService({
    runtime,
    manager: Promise.resolve(manager),
  });
  const service = await acquireProcessService<
    SubagentRuntime,
    SubagentManagerShape
  >({ timeoutMs: 0 });
  return { runtime, manager, service, parent, provider, id };
}

function record(index: number, options: Record<string, unknown>): AgentRecord {
  return {
    index,
    label: typeof options.label === "string" ? options.label : `agent-${index}`,
    state: "running",
    startedAt: Date.now(),
    preview: "",
    usage: emptyUsage(),
    transcript: [],
  };
}

test(
  "live workflow DSL mixes Pi, Claude, and Codex structured agents",
  { skip: !live, timeout: 180_000 },
  async () => {
    const context = await liveContext();
    const agents: AgentRecord[] = [];
    let index = 0;
    try {
      const source = `
        const S = { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false };
        return await parallel([
          () => agent("Return word pi via structured output.", { harness: "pi", model: ${JSON.stringify(`${context.provider}/${context.id}`)}, effort: "off", label: "pi", schema: S }),
          () => agent("Return only JSON with word claude.", { harness: "claude", model: "haiku", effort: "off", label: "claude", schema: S }),
          () => agent("Return JSON with word codex.", { harness: "codex", effort: "low", label: "codex", schema: S }),
        ]);
      `;
      const abort = new AbortController();
      const result = (await runWorkflowSandbox({
        source,
        args: undefined,
        cwd: process.cwd(),
        signal: abort.signal,
        onPhase: () => {},
        onAgent: (prompt, options, signal) => {
          const agent = record(++index, options as Record<string, unknown>);
          agents.push(agent);
          return executeManagerWorkflowAgent(prompt, options, {
            service: context.service,
            runId: "wf_aaaaaaaaaaaa",
            cwd: process.cwd(),
            parent: context.parent,
            record: agent,
            signal,
            onUpdate: () => {},
          });
        },
      })) as Array<{
        ok: boolean;
        structured?: { word?: string };
        error?: string;
      }>;
      assert.deepEqual(
        result.map((item) => [item.ok, item.structured?.word, item.error]),
        [
          [true, "pi", undefined],
          [true, "claude", undefined],
          [true, "codex", undefined],
        ],
      );
      assert.deepEqual(agents.map((agent) => agent.harness).sort(), [
        "claude",
        "codex",
        "pi",
      ]);
    } finally {
      disposeProcessService(context.service.ownerToken, "Live test finished");
      await context.runtime.runPromise(context.manager.disposeAll);
      await context.runtime.dispose();
      resetProcessServiceRegistryForTests();
    }
  },
);

test(
  "live cancelled workflow aborts manager work and settles artifacts",
  { skip: !live, timeout: 60_000 },
  async () => {
    const context = await liveContext();
    const directory = mkdtempSync(join(tmpdir(), "pi-c1-live-cancel-"));
    const abort = new AbortController();
    const agent = record(1, { label: "cancel-live" });
    let agentCompletion: Promise<unknown> | undefined;
    const details: WorkflowDetails = {
      runId: "wf_bbbbbbbbbbbb",
      sessionId: "live-workflow-test",
      background: false,
      status: "running",
      startedAt: Date.now(),
      phases: [{ title: "Cancel" }],
      currentPhase: "Cancel",
      agents: [agent],
      logs: [],
    };
    try {
      const pending = runWorkflowSandbox({
        source:
          'return await agent("Run sleep 30, then return finished.", { harness: "codex", label: "cancel-live" });',
        args: undefined,
        cwd: process.cwd(),
        signal: abort.signal,
        onPhase: () => {},
        onAgent: (prompt, options, signal) => {
          agentCompletion = executeManagerWorkflowAgent(prompt, options, {
            service: context.service,
            runId: details.runId,
            cwd: process.cwd(),
            parent: context.parent,
            record: agent,
            signal,
            onUpdate: () => {},
          });
          return agentCompletion as Promise<any>;
        },
      });
      while (!agent.displayId) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      abort.abort(new Error("live cancellation"));
      await assert.rejects(pending, /Workflow was aborted/);
      assert.ok(agentCompletion);
      await agentCompletion;
      details.status = "aborted";
      details.finishedAt = Date.now();
      details.error = "live cancellation";
      persistWorkflowJson(directory, details);
      const artifact = JSON.parse(
        readFileSync(join(directory, "workflow.json"), "utf8"),
      ) as WorkflowDetails;
      assert.equal(agent.state, "error");
      assert.match(agent.error ?? "", /aborted/i);
      assert.equal(artifact.status, "aborted");
      assert.equal(artifact.agents[0]?.state, "error");
      assert.equal(context.manager.view.get(agent.displayId!)?.status, "error");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      disposeProcessService(context.service.ownerToken, "Live test finished");
      await context.runtime.dispose();
      resetProcessServiceRegistryForTests();
    }
  },
);
