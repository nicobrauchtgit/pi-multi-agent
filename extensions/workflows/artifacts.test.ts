import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  boundedArtifactTranscript,
  createWorkflowPersistence,
  persistWorkflowJson,
} from "./artifacts.ts";
import { normalizeDetails } from "./dashboard.ts";
import {
  emptyUsage,
  type AgentRecord,
  type TranscriptEntry,
  type WorkflowDetails,
} from "./model.ts";

function workflowDetails(): WorkflowDetails {
  return {
    runId: "wf_123456789abc",
    sessionId: "session_fixture",
    background: false,
    status: "running",
    startedAt: 1,
    phases: [],
    agents: [],
    logs: [],
  };
}

test("artifact transcript keeps the initial prompt, marker, and newest entries", () => {
  const prompt = `initial:${"p".repeat(70)}`;
  const transcript = [
    { role: "user" as const, text: prompt },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "assistant" as const,
      text: `entry-${index}:${String(index).repeat(70)}`,
    })),
  ];

  const bounded = boundedArtifactTranscript(transcript, {
    maxBytes: 256,
    entryMaxBytes: 80,
  });

  assert.equal(bounded[0]?.role, "user");
  assert.equal(bounded[0]?.text, prompt);
  assert.match(bounded[1]?.text ?? "", /artifact transcript truncated/);
  assert.equal(bounded.at(-1)?.text, transcript.at(-1)?.text);
  assert.equal(
    bounded.some((entry) => entry.text.startsWith("entry-0:")),
    false,
  );
  assert.ok(
    bounded.reduce(
      (total, entry) => total + Buffer.byteLength(entry.text, "utf8"),
      0,
    ) <= 256,
  );
});

test("live artifact persistence includes current agents and transcripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-artifacts-"));
  try {
    const details = workflowDetails();
    details.agents.push({
      index: 1,
      displayId: "sa-1",
      agentId: "agent_11111111-1111-4111-8111-111111111111",
      harness: "codex",
      label: "running-fixture",
      state: "running",
      startedAt: 2,
      preview: "working",
      usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01 },
      transcript: [
        { role: "user", text: "current prompt" },
        {
          role: "tool",
          name: "fixture",
          toolCallId: "call-fixture",
          text: "{}",
          startedAt: 10,
          finishedAt: 25,
          durationMs: 15,
        },
      ],
    });

    persistWorkflowJson(directory, details);

    const workflow = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    const transcripts = JSON.parse(
      readFileSync(join(directory, "transcripts.json"), "utf8"),
    ) as Record<string, TranscriptEntry[]>;
    assert.equal(workflow.agents.length, 1);
    assert.equal(workflow.agents[0]?.label, "running-fixture");
    assert.equal(workflow.agents[0]?.displayId, "sa-1");
    assert.equal(workflow.agents[0]?.harness, "codex");
    assert.equal("structured" in workflow.agents[0]!, false);
    assert.equal(workflow.agents[0]?.usage.input, 10);
    assert.equal(transcripts["1"]?.[0]?.text, "current prompt");
    assert.deepEqual(
      {
        toolCallId: transcripts["1"]?.[1]?.toolCallId,
        startedAt: transcripts["1"]?.[1]?.startedAt,
        finishedAt: transcripts["1"]?.[1]?.finishedAt,
        durationMs: transcripts["1"]?.[1]?.durationMs,
      },
      {
        toolCallId: "call-fixture",
        startedAt: 10,
        finishedAt: 25,
        durationMs: 15,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("large per-agent structured values cannot destroy workflow core state", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-structured-"));
  try {
    const details = workflowDetails();
    details.status = "completed";
    details.finishedAt = 3;
    for (let index = 1; index <= 20; index++) {
      details.agents.push({
        index,
        label: `agent-${index}`,
        state: "done",
        startedAt: 1,
        finishedAt: 2,
        preview: "done",
        usage: emptyUsage(),
        transcript: [],
        // Simulate an unexpected runtime object carrying a large structured
        // mirror. The AgentRecord contract intentionally omits it from workflow.json.
        structured: { payload: "x".repeat(60 * 1024) },
      } as AgentRecord & { structured: unknown });
    }

    persistWorkflowJson(directory, details);
    const workflow = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails & { truncated?: boolean };
    assert.equal(workflow.truncated, undefined);
    assert.equal(workflow.runId, details.runId);
    assert.equal(workflow.sessionId, details.sessionId);
    assert.equal(workflow.status, "completed");
    assert.equal(workflow.agents.length, 20);
    assert.ok(workflow.agents.every((agent) => !("structured" in agent)));
    const normalized = normalizeDetails(details.runId, workflow);
    assert.equal(normalized?.status, "completed");
    assert.equal(normalized?.agents.length, 20);
    assert.ok(
      Buffer.byteLength(
        readFileSync(join(directory, "workflow.json"), "utf8"),
        "utf8",
      ) <=
        1024 * 1024,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow summary overflow degrades fields without losing core records", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-degrade-"));
  try {
    const details = workflowDetails();
    details.status = "failed";
    details.finishedAt = 3;
    details.error = "run-error:" + "r".repeat(64 * 1024);
    details.description = "description:" + "d".repeat(64 * 1024);
    details.logs = Array.from(
      { length: 80 },
      (_, index) => `log-${index}:` + "界".repeat(8 * 1024),
    );
    details.phases = Array.from({ length: 64 }, (_, index) => ({
      title: `phase-${index}`,
      detail: "p".repeat(8 * 1024),
    }));
    for (let index = 1; index <= 32; index++) {
      details.agents.push({
        index,
        label: `agent-${index}`,
        state: "error",
        startedAt: 1,
        finishedAt: 2,
        preview: "v".repeat(8 * 1024),
        error: "e".repeat(64 * 1024),
        schemaError: "s".repeat(64 * 1024),
        usage: emptyUsage(),
        transcript: [],
      });
    }

    persistWorkflowJson(directory, details);
    const text = readFileSync(join(directory, "workflow.json"), "utf8");
    const workflow = JSON.parse(text) as WorkflowDetails & {
      truncated?: boolean;
    };
    assert.equal(workflow.truncated, undefined);
    assert.equal(workflow.status, "failed");
    assert.equal(workflow.agents.length, 32);
    assert.equal(
      workflow.agents.every((agent) => agent.state === "error"),
      true,
    );
    assert.ok(
      Buffer.byteLength(workflow.agents[0]!.error!, "utf8") <= 2 * 1024,
    );
    assert.ok(Buffer.byteLength(text, "utf8") <= 1024 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact persistence defensively bounds workflow metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-bounds-"));
  try {
    const details = workflowDetails();
    const oversized = "界".repeat(400);
    details.currentPhase = oversized;
    details.phases = [{ title: oversized }];
    details.agents.push({
      index: 1,
      label: oversized,
      phase: oversized,
      state: "done",
      startedAt: 1,
      finishedAt: 2,
      preview: "done",
      usage: emptyUsage(),
      transcript: [],
    });
    persistWorkflowJson(directory, details);
    const workflow = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.ok(Buffer.byteLength(workflow.currentPhase!, "utf8") <= 256);
    assert.ok(Buffer.byteLength(workflow.phases[0]!.title, "utf8") <= 256);
    assert.ok(Buffer.byteLength(workflow.agents[0]!.label, "utf8") <= 256);
    assert.ok(Buffer.byteLength(workflow.agents[0]!.phase!, "utf8") <= 256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow checkpoints throttle updates and support immediate/final flushes", async () => {
  const details = workflowDetails();
  const snapshots: WorkflowDetails[] = [];
  const persistence = createWorkflowPersistence("fixture", details, {
    intervalMs: 15,
    persist: (_runDir, current) => snapshots.push(structuredClone(current)),
  });

  details.currentPhase = "Scan";
  persistence.checkpoint();
  details.currentPhase = "Review";
  persistence.checkpoint();
  assert.equal(snapshots.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.currentPhase, "Review");

  details.status = "completed";
  persistence.checkpoint({ immediate: true });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]?.status, "completed");

  details.finishedAt = 3;
  persistence.flush();
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[2]?.finishedAt, 3);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(snapshots.length, 3);
});
