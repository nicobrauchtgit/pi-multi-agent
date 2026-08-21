import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDetails } from "./dashboard.ts";

test("dashboard reads pre-C1 artifacts without manager identity fields", () => {
  const details = normalizeDetails("wf_111111111111", {
    status: "completed",
    startedAt: 1,
    phases: [{ title: "Old" }],
    agents: [
      {
        index: 1,
        label: "old agent",
        state: "done",
        startedAt: 2,
        preview: "done",
        usage: { turns: 1 },
      },
    ],
  });
  assert.ok(details);
  assert.equal(details.agents[0]?.displayId, undefined);
  assert.equal(details.agents[0]?.harness, undefined);
  assert.equal(details.agents[0]?.usage.turns, 1);
});

test("dashboard rejects corrupt usage fields while preserving valid values", () => {
  const details = normalizeDetails("wf_121212121212", {
    status: "completed",
    startedAt: 1,
    agents: [
      {
        index: 1,
        label: "corrupt usage",
        state: "done",
        usage: {
          input: "100",
          output: Number.NaN,
          cacheRead: -1,
          cacheWrite: 3,
          cost: Number.POSITIVE_INFINITY,
          turns: 2.9,
          contextTokens: 50,
        },
      },
    ],
  });
  assert.ok(details);
  assert.deepEqual(details.agents[0]?.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 3,
    cost: 0,
    turns: 2,
    contextTokens: 50,
  });
});

test("dashboard normalizes manager-backed identity, usage, schema state, and timing", () => {
  const oversized = "界".repeat(400);
  const details = normalizeDetails("wf_222222222222", {
    status: "completed",
    startedAt: 1,
    phases: [{ title: oversized }],
    agents: [
      {
        index: 1,
        displayId: "sa-4",
        agentId: "agent_11111111-1111-4111-8111-111111111111",
        harness: "claude",
        label: oversized,
        phase: oversized,
        state: "done",
        startedAt: 2,
        preview: "done",
        schemaError: "fixture schema error",
        usage: { input: 10, output: 4, cost: 0.2, turns: 1 },
        transcript: [
          {
            role: "toolResult",
            name: "read",
            text: "ok",
            toolCallId: "call-1",
            startedAt: 10,
            finishedAt: 15,
            durationMs: 5,
          },
        ],
      },
    ],
  });
  assert.ok(details);
  const agent = details.agents[0]!;
  assert.equal(agent.displayId, "sa-4");
  assert.equal(agent.harness, "claude");
  assert.equal(agent.schemaError, "fixture schema error");
  assert.equal(agent.usage.input, 10);
  assert.equal(agent.transcript[0]?.durationMs, 5);
  assert.ok(Buffer.byteLength(agent.label, "utf8") <= 256);
  assert.ok(Buffer.byteLength(agent.phase!, "utf8") <= 256);
});
