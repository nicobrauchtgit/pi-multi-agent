import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  jsonSchemaToTypebox,
  STRUCTURED_OUTPUT_MAX_BYTES,
} from "./json-schema.ts";

export {
  isJsonSchema,
  jsonSchemaToTypebox,
  JSON_SCHEMA_MAX_BYTES,
  JSON_SCHEMA_MAX_DEPTH,
  JSON_SCHEMA_MAX_NODES,
  STRUCTURED_OUTPUT_MAX_BYTES,
} from "./json-schema.ts";

/** Instructs Pi children to finish through the terminating result tool. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

function assertBoundedStructuredValue(value: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Fall through to the stable tool-facing error below.
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > STRUCTURED_OUTPUT_MAX_BYTES
  ) {
    throw new Error(
      `structured output must be JSON no larger than ${STRUCTURED_OUTPUT_MAX_BYTES} bytes`,
    );
  }
}

/**
 * Terminating Pi tool injected when a schema is supplied. Pi validates its
 * arguments against `parameters` before execute; execute adds a byte bound and
 * captures the current run's validated value.
 */
export function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      assertBoundedStructuredValue(params);
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}
