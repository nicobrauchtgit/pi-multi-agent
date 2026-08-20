import { Check, Errors } from "typebox/value";
import {
  isJsonSchema,
  jsonSchemaToTypebox,
  jsonSchemaValidationError,
  STRUCTURED_OUTPUT_MAX_BYTES,
} from "../../shared/json-schema.ts";
import type { RunOutcome } from "./domain.ts";

export const STRUCTURED_SOURCE_MAX_BYTES = 64 * 1024;
const MAX_JSON_CANDIDATES = 2;
const VALIDATION_ERROR_MAX_COUNT = 8;
const VALIDATION_ERROR_MAX_LENGTH = 4_096;

export const MISSING_STRUCTURED_OUTPUT_ERROR =
  "Agent finished without calling structured_output; no structured result matching the schema was produced.";

export { isJsonSchema };

export type StructuredExtraction =
  | { readonly value: unknown; readonly error?: never }
  | { readonly value?: never; readonly error: string };

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly value: unknown;
}

function parseCandidate(text: string): StructuredExtraction {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "invalid JSON",
    };
  }
}

function balancedCandidates(
  text: string,
  excludedRanges: ReadonlyArray<{ start: number; end: number }>,
  maxCandidates: number,
): { candidates: Candidate[]; sawUnbalanced: boolean } {
  const candidates: Candidate[] = [];
  const stack: string[] = [];
  let candidateStart = -1;
  let inString = false;
  let escaped = false;
  let sawUnbalanced = false;
  let rangeIndex = 0;

  // One forward pass only. A malformed opening delimiter consumes the rest of
  // that candidate rather than restarting a scan from each nested delimiter;
  // this intentionally favors bounded work over guessing inside broken JSON.
  for (let index = 0; index < text.length; index++) {
    while (
      rangeIndex < excludedRanges.length &&
      index >= excludedRanges[rangeIndex].end
    ) {
      rangeIndex++;
    }
    const excluded = excludedRanges[rangeIndex];
    if (excluded && index >= excluded.start && index < excluded.end) {
      index = excluded.end - 1;
      continue;
    }

    const char = text[index];
    if (stack.length === 0) {
      if (char !== "{" && char !== "[") continue;
      candidateStart = index;
      stack.push(char);
      inString = false;
      escaped = false;
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const expected = char === "}" ? "{" : "[";
    if (stack.at(-1) !== expected) {
      sawUnbalanced = true;
      stack.length = 0;
      candidateStart = -1;
      continue;
    }
    stack.pop();
    if (stack.length > 0) continue;

    const parsed = parseCandidate(text.slice(candidateStart, index + 1));
    if ("value" in parsed) {
      candidates.push({
        start: candidateStart,
        end: index + 1,
        value: parsed.value,
      });
      if (candidates.length >= maxCandidates) break;
    }
    candidateStart = -1;
  }

  if (stack.length > 0) sawUnbalanced = true;
  return { candidates, sawUnbalanced };
}

/**
 * Extract one unambiguous JSON value from a backend's final assistant text.
 * Exact JSON is preferred, followed by a JSON code fence, then a balanced
 * object/array embedded in prose. Multiple independently parseable values are
 * rejected rather than guessing which one is final.
 */
export function extractJsonCandidate(text: string): StructuredExtraction {
  if (Buffer.byteLength(text, "utf8") > STRUCTURED_SOURCE_MAX_BYTES) {
    return {
      error: `final response exceeds the ${STRUCTURED_SOURCE_MAX_BYTES}-byte structured extraction limit`,
    };
  }

  const trimmed = text.trim();
  if (!trimmed) return { error: "final response was empty; expected JSON" };

  const whole = parseCandidate(trimmed);
  if ("value" in whole) return whole;

  const fenced: Candidate[] = [];
  const fenceRanges: Array<{ start: number; end: number }> = [];
  let fenceError: string | undefined;
  const fencePattern = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    fenceRanges.push({ start, end });
    const body = (match[1] ?? "").trim();
    const parsed = parseCandidate(body);
    if ("value" in parsed) {
      if (fenced.length < MAX_JSON_CANDIDATES) {
        fenced.push({ start, end, value: parsed.value });
      }
    } else {
      fenceError ??= parsed.error;
    }
  }

  if (fenced.length >= MAX_JSON_CANDIDATES) {
    return {
      error:
        "final response contained multiple JSON candidates; expected exactly one",
    };
  }
  const balanced = balancedCandidates(
    text,
    fenceRanges,
    MAX_JSON_CANDIDATES - fenced.length,
  );
  const candidates = [...fenced, ...balanced.candidates].sort(
    (a, b) => a.start - b.start,
  );

  if (candidates.length > 1) {
    return {
      error:
        "final response contained multiple JSON candidates; expected exactly one",
    };
  }
  if (candidates.length === 1) return { value: candidates[0].value };
  if (fenceError) {
    return {
      error: `JSON code block could not be parsed: ${fenceError}`,
    };
  }
  if (balanced.sawUnbalanced) {
    return {
      error:
        "final response contained incomplete or invalid JSON; expected one complete JSON value",
    };
  }
  return {
    error: `final response was not valid JSON: ${whole.error}`,
  };
}

function validationErrorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error);
  const record = error as {
    instancePath?: unknown;
    message?: unknown;
  };
  const path =
    typeof record.instancePath === "string" && record.instancePath
      ? record.instancePath
      : "$";
  const message =
    typeof record.message === "string" ? record.message : "is invalid";
  return `${path} ${message}`;
}

/** Validate a parsed JSON value against the caller's bounded JSON Schema. */
export function validateStructuredValue(
  schema: unknown,
  value: unknown,
): { readonly error?: string } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Report through the stable message below.
  }
  if (serialized === undefined) {
    return { error: "structured result is not a JSON value" };
  }
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > STRUCTURED_OUTPUT_MAX_BYTES) {
    return {
      error: `structured result is ${size} bytes; maximum is ${STRUCTURED_OUTPUT_MAX_BYTES} bytes`,
    };
  }

  try {
    const type = jsonSchemaToTypebox(schema);
    if (Check(type, value)) return {};
    const errors = Errors(type, value)
      .slice(0, VALIDATION_ERROR_MAX_COUNT)
      .map(validationErrorText);
    const suffix =
      errors.length > 0 ? errors.join("; ") : "value did not match";
    return {
      error: `schema validation failed: ${suffix}`.slice(
        0,
        VALIDATION_ERROR_MAX_LENGTH,
      ),
    };
  } catch (error) {
    return {
      error: `schema validation could not run: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, VALIDATION_ERROR_MAX_LENGTH),
    };
  }
}

export function extractStructuredJson(
  text: string,
  schema: unknown,
): StructuredExtraction {
  const extracted = extractJsonCandidate(text);
  if (!("value" in extracted)) return extracted;
  const validated = validateStructuredValue(schema, extracted.value);
  return validated.error
    ? { error: validated.error }
    : { value: extracted.value };
}

/** Persistent Claude instruction: it applies to every turn in one SDK query. */
export function buildStructuredTextInstruction(schema: unknown): string {
  const schemaError = jsonSchemaValidationError(schema);
  if (schemaError) {
    throw new Error(`structured output schema is invalid: ${schemaError}`);
  }
  // Keep schema text inert inside the XML-like delimiter. JSON's \u003c escape
  // decodes to the original description while preventing a literal closing
  // tag from terminating the schema block in Claude's system prompt.
  const serialized = JSON.stringify(schema).replaceAll("<", "\\u003c");
  return [
    "For every user turn in this session, complete the task using tools as needed, then make your final assistant response exactly one JSON value matching the schema below.",
    "Do not wrap the final JSON in a Markdown fence and do not add prose before or after it.",
    `<json_schema>${serialized}</json_schema>`,
  ].join("\n");
}

/** Shared Claude/Codex successful-turn normalization and validation. */
export function completeTextRun(
  finalText: string,
  schema: unknown | undefined,
): RunOutcome {
  if (schema === undefined) return { _tag: "Completed", finalText };
  const extracted = extractStructuredJson(finalText, schema);
  if ("value" in extracted) {
    return { _tag: "Completed", finalText, structured: extracted.value };
  }
  return {
    _tag: "Failed",
    errorText: `Structured output invalid: ${extracted.error}`,
    partialText: finalText || undefined,
    schemaError: extracted.error,
  };
}
