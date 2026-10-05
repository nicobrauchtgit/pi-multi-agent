import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_HARNESS_MAP,
  TASK_HARNESS_PROMPT,
} from "../shared/harness-routing.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  formatStructuredResult,
  structuredResultDetails,
  structuredResultWaitBudget,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
} from "./src/prompt.ts";

test("task harness preferences are injected without choosing models", () => {
  assert.deepEqual(TASK_HARNESS_MAP, {
    planning: ["claude"],
    implementation: ["codex"],
    review: ["claude", "codex"],
  });
  assert.ok(SUBAGENT_SPAWN_PROMPT_GUIDELINES.includes(TASK_HARNESS_PROMPT));
  assert.match(TASK_HARNESS_PROMPT, /Every review must use two independent/);
  assert.match(TASK_HARNESS_PROMPT, /Choose each model separately/);
});

test("schema-less prompt results retain their previous text", () => {
  assert.equal(
    buildSubagentSpawnResult({
      id: "sa-1",
      title: "review",
      harness: "pi",
      modelLabel: "provider/model",
      cwd: "/repo",
    }),
    'Spawned subagent sa-1 "review" (pi: provider/model, /repo).\n' +
      "It runs in the background. Its result will be delivered to you when it finishes, " +
      'or use subagent_wait(ids: ["sa-1"]) to block for it, subagent_followup(id: "sa-1", prompt: "...") to continue it in this session, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.',
  );
  assert.equal(
    buildSubagentResultMessage({
      id: "sa-1",
      title: "review",
      status: "done",
      output: "plain output",
    }),
    'Subagent sa-1 "review" finished.\n\nplain output',
  );
});

test("subagent_wait uses an integer structured-result byte budget", () => {
  assert.equal(structuredResultWaitBudget(1027), 513);
  assert.equal(Number.isInteger(structuredResultWaitBudget(1027)), true);
  assert.equal(structuredResultWaitBudget(100_000), 8 * 1024);
});

test("structured formatting truncates on UTF-8 boundaries", () => {
  const formatted = formatStructuredResult({ text: "é".repeat(20_000) }, 1024);
  assert.ok(Buffer.byteLength(formatted, "utf8") <= 1024);
  assert.equal(formatted.includes("�"), false);
  assert.match(formatted, /structured result truncated/);
});

test("large structured tool details are replaced by bounded previews", () => {
  const details = structuredResultDetails({ text: "x".repeat(64 * 1024) });
  assert.equal((details as { truncated?: boolean }).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(details), "utf8") < 4 * 1024);
  assert.deepEqual(structuredResultDetails({ ok: true }), { ok: true });
});

test("structured results and schema failures are rendered distinctly", () => {
  const success = buildSubagentResultMessage({
    id: "sa-2",
    title: "scan",
    status: "done",
    output: "supporting prose",
    structured: { ok: true },
  });
  assert.match(success, /Structured result:\n```json\n/);
  assert.match(success, /"ok": true/);
  assert.match(success, /supporting prose$/);

  const bounded = buildSubagentResultMessage({
    id: "sa-2",
    title: "scan",
    status: "done",
    output: "é".repeat(24 * 1024),
    structured: { text: "é".repeat(32 * 1024) },
  });
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 32 * 1024);
  assert.equal(bounded.includes("�"), false);
  assert.match(bounded, /result message output truncated/);

  const failure = buildSubagentResultMessage({
    id: "sa-3",
    title: "scan",
    status: "error",
    errorText: "Structured output invalid",
    schemaError: "$.ok must be boolean",
    output: "partial response",
  });
  assert.match(failure, /Error: Structured output invalid/);
  assert.match(failure, /Schema error: \$\.ok must be boolean/);
  assert.match(failure, /partial response$/);
});
