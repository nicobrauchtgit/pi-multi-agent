import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  codexJsonSchemaCompatibilityError,
  isJsonSchema,
  JSON_SCHEMA_MAX_BYTES,
  jsonSchemaToTypebox,
  jsonSchemaValidationError,
} from "./json-schema.ts";

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    score: { type: "number" },
    enabled: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["name", "score", "enabled", "tags"],
  additionalProperties: false,
};

test("bounded JSON schemas accept a semantically valid object schema", () => {
  assert.equal(isJsonSchema(schema), true);
  assert.deepEqual(jsonSchemaToTypebox(schema), Type.Unsafe(schema));
  assert.equal(
    Object.getOwnPropertySymbols(jsonSchemaToTypebox(schema)).includes(
      Symbol.for("TypeBox.Kind"),
    ),
    true,
  );
});

test("schema validation rejects unconstrained, invalid, and non-object roots", () => {
  for (const invalid of [
    {},
    { foo: 1 },
    { type: "bogus" },
    { type: "array", items: { type: "string" } },
    { type: "object" },
    { type: "object", properties: {}, required: "not-an-array" },
  ]) {
    assert.equal(isJsonSchema(invalid), false, JSON.stringify(invalid));
  }
  assert.match(
    jsonSchemaValidationError({ type: "array", items: { type: "string" } }) ??
      "",
    /root type must be "object"/,
  );
});

test("regex-bearing schema keywords are rejected before TypeBox validation", () => {
  for (const keyword of ["pattern", "format", "patternProperties"]) {
    const property =
      keyword === "patternProperties"
        ? { type: "object", properties: {}, [keyword]: { "^(a+)+$": {} } }
        : { type: "string", [keyword]: "^(a+)+$" };
    const candidate = {
      type: "object",
      properties: { value: property },
      required: ["value"],
    };
    assert.equal(isJsonSchema(candidate), false, keyword);
    assert.match(jsonSchemaValidationError(candidate) ?? "", /regex/i);
  }
});

test("bounded JSON schemas reject dangerous keys, cycles, depth, and size", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.equal(
      isJsonSchema(
        JSON.parse(
          `{"type":"object","properties":{"${key}":{"type":"string"}}}`,
        ),
      ),
      false,
    );
  }

  const cyclic: Record<string, unknown> = {
    type: "object",
    properties: {},
  };
  cyclic.self = cyclic;
  assert.equal(isJsonSchema(cyclic), false);

  let deep: Record<string, unknown> = {
    type: "object",
    properties: {},
  };
  const root = deep;
  for (let index = 0; index < 30; index++) {
    const next: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    (deep.properties as Record<string, unknown>).next = next;
    deep = next;
  }
  assert.equal(isJsonSchema(root), false);
  assert.equal(
    isJsonSchema({
      type: "object",
      properties: {},
      description: "x".repeat(JSON_SCHEMA_MAX_BYTES),
    }),
    false,
  );
  assert.equal(isJsonSchema([]), false);
  assert.equal(isJsonSchema(null), false);
});

test("shared schema nodes are accepted while actual cycles are rejected", () => {
  const stringSchema = { type: "string" };
  const dag = {
    type: "object",
    properties: { first: stringSchema, second: stringSchema },
    required: ["first", "second"],
  };
  assert.equal(isJsonSchema(dag), true);
});

test("Codex strict compatibility is checked before turn dispatch", () => {
  assert.equal(codexJsonSchemaCompatibilityError(schema), undefined);
  assert.match(
    codexJsonSchemaCompatibilityError({
      type: "object",
      properties: { value: { type: "string" } },
      required: [],
      additionalProperties: false,
    }) ?? "",
    /required must list every property/,
  );
  assert.match(
    codexJsonSchemaCompatibilityError({
      type: "object",
      properties: {},
      required: [],
    }) ?? "",
    /additionalProperties must be false/,
  );
  assert.match(
    codexJsonSchemaCompatibilityError({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      allOf: [{ type: "object", properties: {} }],
    }) ?? "",
    /allOf.*not supported by Codex strict/i,
  );
});

test("jsonSchemaToTypebox reports a stable semantic validation error", () => {
  assert.throws(
    () => jsonSchemaToTypebox({ type: "bogus" }),
    /structured output schema is invalid: .*type is invalid/,
  );
});
