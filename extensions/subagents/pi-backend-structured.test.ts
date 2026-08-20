import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { makeStructuredOutputTool } from "../shared/structured-output.ts";
import { createPiStructuredCapture, piBackend } from "./src/backends/pi.ts";
import type { SpawnTask } from "./src/domain.ts";

const schema = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
};

test("Pi structured capture resets at every native run boundary", () => {
  const capture = createPiStructuredCapture(true);
  capture.capture({ value: 1 });
  assert.deepEqual(capture.complete("first"), {
    _tag: "Completed",
    finalText: "first",
    structured: { value: 1 },
  });

  capture.reset();
  const missing = capture.complete("second partial");
  assert.equal(missing._tag, "Failed");
  if (missing._tag === "Failed") {
    assert.match(
      missing.schemaError ?? "",
      /without calling structured_output/,
    );
    assert.equal(missing.partialText, "second partial");
  }

  capture.reset();
  capture.capture({ value: 3 });
  assert.deepEqual(capture.complete("third"), {
    _tag: "Completed",
    finalText: "third",
    structured: { value: 3 },
  });
});

test("Pi's tool boundary captures valid values without coercing invalid ones", async () => {
  let captured: unknown;
  const tool = makeStructuredOutputTool(schema, (value) => {
    captured = value;
  });

  assert.throws(
    () =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "structured_output",
        arguments: { value: "5" },
      }),
    /Validation failed.*value.*number/s,
  );

  const result = await tool.execute(
    "call-2",
    { value: 5 },
    undefined,
    undefined,
    {} as never,
  );
  assert.deepEqual(captured, { value: 5 });
  assert.equal(result.terminate, true);
});

test("the real Pi backend still fails fast without a parent model registry", async () => {
  const task: SpawnTask = {
    prompt: "test",
    title: "test",
    cwd: process.cwd(),
    parent: { parentCwd: process.cwd(), projectTrusted: false },
  };
  await assert.rejects(
    Effect.runPromise(piBackend.spawn(task).pipe(Effect.scoped)),
    /requires the parent session's model registry/,
  );
});
