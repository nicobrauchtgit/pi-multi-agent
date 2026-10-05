import { Type, type TSchema } from "typebox";

export const JSON_SCHEMA_MAX_BYTES = 64 * 1024;
export const JSON_SCHEMA_MAX_DEPTH = 24;
export const JSON_SCHEMA_MAX_NODES = 10_000;
export const STRUCTURED_OUTPUT_MAX_BYTES = 64 * 1024;

const LEGACY_TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
const JSON_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const UNSAFE_REGEX_KEYWORDS = new Set([
  "format",
  "pattern",
  "patternProperties",
]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$comment",
  "$id",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "uniqueItems",
  "writeOnly",
]);
const CODEX_SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "properties",
  "required",
  "title",
  "type",
  "uniqueItems",
]);

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathForProperty(path: string, key: string) {
  return `${path}.${key}`;
}

function schemaTypes(schema: JsonObject): string[] | undefined {
  if (typeof schema.type === "string") {
    return JSON_TYPES.has(schema.type) ? [schema.type] : undefined;
  }
  if (!Array.isArray(schema.type) || schema.type.length === 0) return undefined;
  const values = schema.type.filter(
    (value): value is string => typeof value === "string",
  );
  if (
    values.length !== schema.type.length ||
    new Set(values).size !== values.length ||
    values.some((value) => !JSON_TYPES.has(value))
  ) {
    return undefined;
  }
  return values;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate the conservative JSON-Schema subset shared by Pi, Claude, and
 * Codex. In particular, regex-bearing keywords are forbidden because TypeBox
 * executes their regular expressions synchronously in the parent process.
 */
function semanticSchemaError(
  schema: unknown,
  path = "$",
  root = false,
): string | undefined {
  if (!isPlainObject(schema)) return `${path} must be a JSON object schema`;

  for (const key of Object.keys(schema)) {
    if (UNSAFE_REGEX_KEYWORDS.has(key)) {
      return `${path}.${key} is not supported because regex validation is unsafe`;
    }
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      return `${path}.${key} is not a supported structured-output schema keyword`;
    }
  }

  const hasType = Object.hasOwn(schema, "type");
  const types = hasType ? schemaTypes(schema) : undefined;
  if (hasType && !types) return `${path}.type is invalid`;
  if (root && (types?.length !== 1 || types[0] !== "object")) {
    return 'schema root type must be "object"';
  }

  const hasConstraint =
    hasType ||
    Object.hasOwn(schema, "const") ||
    Object.hasOwn(schema, "enum") ||
    ["allOf", "anyOf", "oneOf", "not"].some((key) =>
      Object.hasOwn(schema, key),
    );
  if (!hasConstraint) {
    return `${path} must declare type, const, enum, or a supported composition keyword`;
  }

  for (const key of ["$comment", "$id", "$schema", "description", "title"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") {
      return `${path}.${key} must be a string`;
    }
  }
  for (const key of ["deprecated", "readOnly", "uniqueItems", "writeOnly"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "boolean") {
      return `${path}.${key} must be a boolean`;
    }
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) {
    return `${path}.examples must be an array`;
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0)
  ) {
    return `${path}.enum must be a non-empty array`;
  }

  for (const key of [
    "maxItems",
    "maxLength",
    "maxProperties",
    "minItems",
    "minLength",
    "minProperties",
  ]) {
    if (schema[key] !== undefined && !nonNegativeInteger(schema[key])) {
      return `${path}.${key} must be a non-negative integer`;
    }
  }
  for (const key of [
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maximum",
    "minimum",
  ]) {
    if (schema[key] !== undefined && !finiteNumber(schema[key])) {
      return `${path}.${key} must be a finite number`;
    }
  }
  if (
    schema.multipleOf !== undefined &&
    (!finiteNumber(schema.multipleOf) || schema.multipleOf <= 0)
  ) {
    return `${path}.multipleOf must be a positive finite number`;
  }

  const objectKeywords = [
    "properties",
    "required",
    "additionalProperties",
    "minProperties",
    "maxProperties",
  ];
  if (
    objectKeywords.some((key) => Object.hasOwn(schema, key)) &&
    !types?.includes("object")
  ) {
    return `${path} uses object keywords without type "object"`;
  }
  if (types?.includes("object")) {
    if (!isPlainObject(schema.properties)) {
      return `${path}.properties must be a JSON object`;
    }
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      const error = semanticSchemaError(
        propertySchema,
        pathForProperty(`${path}.properties`, name),
      );
      if (error) return error;
    }
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((name) => typeof name !== "string") ||
        new Set(schema.required).size !== schema.required.length
      ) {
        return `${path}.required must be an array of unique strings`;
      }
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    ) {
      const error = semanticSchemaError(
        schema.additionalProperties,
        `${path}.additionalProperties`,
      );
      if (error) return error;
    }
  }

  const arrayKeywords = ["items", "minItems", "maxItems", "uniqueItems"];
  if (
    arrayKeywords.some((key) => Object.hasOwn(schema, key)) &&
    !types?.includes("array")
  ) {
    return `${path} uses array keywords without type "array"`;
  }
  if (types?.includes("array")) {
    if (!isPlainObject(schema.items)) {
      return `${path}.items must be one JSON object schema`;
    }
    const error = semanticSchemaError(schema.items, `${path}.items`);
    if (error) return error;
  }

  if (
    ["minLength", "maxLength"].some((key) => Object.hasOwn(schema, key)) &&
    !types?.includes("string")
  ) {
    return `${path} uses string keywords without type "string"`;
  }
  if (
    [
      "exclusiveMaximum",
      "exclusiveMinimum",
      "maximum",
      "minimum",
      "multipleOf",
    ].some((key) => Object.hasOwn(schema, key)) &&
    !types?.some((type) => type === "number" || type === "integer")
  ) {
    return `${path} uses numeric keywords without a numeric type`;
  }

  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0) {
      return `${path}.${key} must be a non-empty array of schemas`;
    }
    for (let index = 0; index < schema[key].length; index++) {
      const error = semanticSchemaError(
        schema[key][index],
        `${path}.${key}[${index}]`,
      );
      if (error) return error;
    }
  }
  if (schema.not !== undefined) {
    const error = semanticSchemaError(schema.not, `${path}.not`);
    if (error) return error;
  }

  return undefined;
}

/** Return a stable explanation when a value is not an accepted schema. */
export function jsonSchemaValidationError(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "schema must be a JSON object";

  try {
    const activePath = new WeakSet<object>();
    let nodes = 0;
    const validateJson = (current: unknown, depth: number): boolean => {
      if (++nodes > JSON_SCHEMA_MAX_NODES || depth > JSON_SCHEMA_MAX_DEPTH) {
        return false;
      }
      if (
        current === null ||
        typeof current === "string" ||
        typeof current === "boolean"
      ) {
        return true;
      }
      if (typeof current === "number") return Number.isFinite(current);
      if (typeof current !== "object") return false;
      if (activePath.has(current)) return false;
      if (!Array.isArray(current) && !isPlainObject(current)) return false;

      activePath.add(current);
      try {
        if (Array.isArray(current)) {
          return current.every((item) => validateJson(item, depth + 1));
        }
        return Object.keys(current).every((key) => {
          if (
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype"
          ) {
            return false;
          }
          return validateJson(current[key], depth + 1);
        });
      } finally {
        activePath.delete(current);
      }
    };

    if (!validateJson(value, 0)) {
      return "schema must be plain, acyclic JSON within depth and node limits";
    }
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > JSON_SCHEMA_MAX_BYTES
    ) {
      return `schema must be no larger than ${JSON_SCHEMA_MAX_BYTES} bytes`;
    }
    return semanticSchemaError(value, "$", true);
  } catch {
    return "schema could not be inspected safely";
  }
}

export function isJsonSchema(value: unknown): value is TSchema {
  return jsonSchemaValidationError(value) === undefined;
}

/**
 * Codex sends output schemas to OpenAI strict mode. Reject the subset known to
 * fail there before opening a thread or persisting an unusable role contract.
 */
export function codexJsonSchemaCompatibilityError(
  value: unknown,
): string | undefined {
  const baseError = jsonSchemaValidationError(value);
  if (baseError) return baseError;

  const visit = (schema: JsonObject, path: string): string | undefined => {
    for (const key of Object.keys(schema)) {
      if (!CODEX_SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
        return `${path}.${key} is not supported by Codex strict output schemas`;
      }
    }

    const types = schemaTypes(schema) ?? [];
    if (types.includes("object")) {
      const properties = schema.properties as JsonObject;
      if (schema.additionalProperties !== false) {
        return `${path}.additionalProperties must be false for Codex strict output schemas`;
      }
      const propertyNames = Object.keys(properties);
      const required = schema.required;
      if (!Array.isArray(required)) {
        return `${path}.required must list every property for Codex strict output schemas`;
      }
      const requiredNames = new Set(required as string[]);
      if (
        requiredNames.size !== propertyNames.length ||
        propertyNames.some((name) => !requiredNames.has(name))
      ) {
        return `${path}.required must list every property for Codex strict output schemas`;
      }
      for (const [name, propertySchema] of Object.entries(properties)) {
        const error = visit(
          propertySchema as JsonObject,
          pathForProperty(`${path}.properties`, name),
        );
        if (error) return error;
      }
    }
    if (types.includes("array")) {
      const error = visit(schema.items as JsonObject, `${path}.items`);
      if (error) return error;
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      const error = visit(
        schema.additionalProperties as JsonObject,
        `${path}.additionalProperties`,
      );
      if (error) return error;
    }
    if (Array.isArray(schema.anyOf)) {
      for (let index = 0; index < schema.anyOf.length; index++) {
        const error = visit(
          schema.anyOf[index] as JsonObject,
          `${path}.anyOf[${index}]`,
        );
        if (error) return error;
      }
    }
    return undefined;
  };

  return visit(value as JsonObject, "$");
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
export function jsonSchemaToTypebox(schema: unknown): TSchema {
  const error = jsonSchemaValidationError(schema);
  if (error) throw new Error(`structured output schema is invalid: ${error}`);
  const type = Type.Unsafe(schema as TSchema);
  // Pi 0.84 checks this TypeBox symbol before applying an extra JSON-schema
  // coercion pass. TypeBox 1.3 uses string metadata instead, so mark this
  // schema explicitly to keep Pi as strict as the Claude/Codex validators.
  Object.defineProperty(type, LEGACY_TYPEBOX_KIND, {
    configurable: false,
    enumerable: false,
    value: "Unsafe",
  });
  return type;
}
