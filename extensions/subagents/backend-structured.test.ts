import assert from "node:assert/strict";
import test from "node:test";
import { claudeStructuredOptions } from "./src/backends/claude.ts";
import {
  buildCodexTurnStartParams,
  codexOutputSchemaSupportError,
} from "./src/backends/codex.ts";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

test("Claude keeps the same base system prompt for ordinary sessions", () => {
  assert.deepEqual(claudeStructuredOptions(undefined), {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
    },
  });
});

test("Claude installs one persistent structured-output system append", () => {
  const options = claudeStructuredOptions(schema);
  assert.deepEqual(options, {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: options.systemPrompt?.append,
    },
  });
  assert.match(options.systemPrompt?.append ?? "", /<json_schema>/);
  assert.match(options.systemPrompt?.append ?? "", /"answer"/);
});

test("Codex includes outputSchema on every structured turn/start", () => {
  const first = buildCodexTurnStartParams({
    threadId: "thread-1",
    text: "first",
    effort: "high",
    schema,
  });
  const followUp = buildCodexTurnStartParams({
    threadId: "thread-1",
    text: "second",
    effort: "high",
    schema,
  });
  assert.deepEqual(first.outputSchema, schema);
  assert.deepEqual(followUp.outputSchema, schema);
  assert.equal(first.effort, "high");
  assert.equal(followUp.effort, "high");
});

test("Codex omits outputSchema for ordinary turns", () => {
  const params = buildCodexTurnStartParams({
    threadId: "thread-1",
    text: "ordinary",
  });
  assert.equal("outputSchema" in params, false);
});

test("Codex outputSchema support is gated by the app-server version", () => {
  assert.equal(
    codexOutputSchemaSupportError({
      userAgent: "pi-subagents/0.147.0 (macOS; arm64)",
    }),
    undefined,
  );
  assert.equal(
    codexOutputSchemaSupportError({
      userAgent: "pi-subagents/1.0.0 (macOS; arm64)",
    }),
    undefined,
  );
  assert.match(
    codexOutputSchemaSupportError({
      userAgent: "pi-subagents/0.146.9 (macOS; arm64)",
    }) ?? "",
    /does not support outputSchema/,
  );
  assert.match(codexOutputSchemaSupportError({}) ?? "", /could not verify/);
});
