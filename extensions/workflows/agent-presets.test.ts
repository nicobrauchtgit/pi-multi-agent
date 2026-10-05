import assert from "node:assert/strict";
import test from "node:test";
import { TASK_HARNESS_PROMPT } from "../shared/harness-routing.ts";
import { WORKFLOW_AGENT_PRESETS, resolveAgentPreset } from "./agent-presets.ts";
import {
  buildWorkflowAgentPrompt,
  WORKFLOW_PROMPT_GUIDELINES,
} from "./prompt.ts";

test("workflow guidance includes task harness preferences", () => {
  assert.ok(WORKFLOW_PROMPT_GUIDELINES.includes(TASK_HARNESS_PROMPT));
});

test("presets exist for the parallel architect/implementer roles", () => {
  assert.deepEqual(Object.keys(WORKFLOW_AGENT_PRESETS).sort(), [
    "architect",
    "implementer",
    "integrator",
    "reviewer",
  ]);
  for (const text of Object.values(WORKFLOW_AGENT_PRESETS)) {
    assert.ok(text.length > 0);
  }
});

test("presets never expose an agent-call or turn budget", () => {
  // An agent told a quota tends to spend it; presets must not anchor one.
  for (const [name, text] of Object.entries(WORKFLOW_AGENT_PRESETS)) {
    const lower = text.toLowerCase();
    assert.doesNotMatch(
      lower,
      /\b\d+\s+(agent\s+)?(calls?|turns?)\b/,
      `${name} leaks a numeric call/turn budget`,
    );
    assert.equal(lower.includes("budget"), false, `${name} mentions a budget`);
    assert.equal(
      lower.includes("max call"),
      false,
      `${name} mentions max calls`,
    );
  }
});

test("architect and implementer encode the disjoint-slice, DRY, local-search model", () => {
  const architect = WORKFLOW_AGENT_PRESETS.architect.toLowerCase();
  assert.ok(architect.includes("contract"));
  assert.ok(architect.includes("own"));
  assert.ok(architect.includes("context pack"));
  assert.ok(architect.includes("dry"));

  const implementer = WORKFLOW_AGENT_PRESETS.implementer.toLowerCase();
  assert.ok(implementer.includes("own"));
  assert.ok(implementer.includes("search"));
  assert.ok(implementer.includes("dry"));
  assert.ok(implementer.includes("architect"));
});

test("resolveAgentPreset maps names, ignores absence, and rejects typos", () => {
  assert.equal(
    resolveAgentPreset("implementer"),
    WORKFLOW_AGENT_PRESETS.implementer,
  );
  assert.equal(resolveAgentPreset(undefined), undefined);
  assert.equal(resolveAgentPreset(null), undefined);
  assert.equal(resolveAgentPreset(42), undefined);
  assert.throws(
    () => resolveAgentPreset("planner"),
    /unknown agent preset: planner/,
  );
});

test("buildWorkflowAgentPrompt prepends a preset and is identity without one", () => {
  assert.equal(buildWorkflowAgentPrompt("do the task"), "do the task");
  const withPreset = buildWorkflowAgentPrompt(
    "do the task",
    WORKFLOW_AGENT_PRESETS.implementer,
  );
  assert.ok(withPreset.startsWith(WORKFLOW_AGENT_PRESETS.implementer));
  assert.ok(withPreset.endsWith("do the task"));
  assert.ok(withPreset.includes("\n\n---\n\n"));
});
