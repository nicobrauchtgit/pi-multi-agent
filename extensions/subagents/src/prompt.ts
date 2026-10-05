/** All model-facing strings for the subagents tools. */
import { TASK_HARNESS_PROMPT } from "../../shared/harness-routing.ts";

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. You choose the harness it runs on: pi (in-process pi session, inherits this environment's tools and config), claude (Claude Code), or codex (Codex CLI). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Pass a bounded, object-root JSON schema when the caller needs a validated structured result on every turn: pi uses a strict terminating structured_output tool, Codex 0.147+ uses native strict turn outputSchema plus local validation, and Claude uses persistent final-JSON instructions plus local validation. Missing or invalid required structured output fails that run while retaining partial text. Optional role stores the schema with the persistent role so later subagent_resume turns keep the same contract, including after Pi restarts. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 4 subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  TASK_HARNESS_PROMPT,
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
  "Use role for reusable specialists (for example reviewer or researcher). Use subagent_followup with a current-session id, or subagent_resume with the role name after a Pi restart. Role records are listed by subagent_roles and removed by subagent_forget.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment), "claude" (Claude Code), or "codex" (Codex CLI). Choose deliberately per task.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: model alias like "sonnet"/"opus"; codex: model slug). Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).",
  role: "Optional persistent role name (letters, digits, '.', '_', '-'; spaces normalize to '-'). Use for specialists you may continue later by id or resume by role after a Pi restart.",
  schema:
    'Optional bounded JSON Schema with root type "object" and explicit properties for a validated result on every turn. Regex-bearing pattern/format keywords are rejected. Codex additionally requires strict-mode schemas (all properties required and additionalProperties: false). The contract is persisted with a role.',
};

export const SUBAGENT_RESUME_TOOL_DESCRIPTION =
  "Continue a persistent subagent role. If the role is already tracked in this Pi session, the prompt is sent to that agent. Otherwise its backend-native Pi, Claude Code, or Codex history is reopened under a fresh current-session subagent id.";

export const SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS = {
  role: "Persistent role name previously supplied to subagent_spawn.",
  prompt:
    "Follow-up prompt for the role. Include the new task or instruction; prior native conversation history is restored.",
  workingDir:
    "Optional working-directory override. Omit to reuse the role's saved directory.",
  model:
    "Optional backend-specific model override. Omit to reuse the role's saved model or native session model.",
  reasoningEffort:
    "Optional reasoning-effort override. Omit to reuse the role's saved effort or backend default.",
  schema:
    "Optional bounded object-root JSON Schema override when reopening an inactive role. Regex-bearing pattern/format keywords are rejected; Codex strict-mode requirements also apply. Omit to reuse the saved contract. An active role keeps its live contract.",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  role?: string;
  structured?: boolean;
}) {
  const roleText = options.role ? `, role ${options.role}` : "";
  const structuredText = options.structured
    ? ", structured output required"
    : "";
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}${roleText}${structuredText}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_followup(id: "${options.id}", prompt: "...") to continue it in this session, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** Choose an integer structured-result allowance within subagent_wait's budget. */
export function structuredResultWaitBudget(remainingBytes: number): number {
  return Math.min(8 * 1024, Math.max(512, Math.floor(remainingBytes / 2)));
}

/** Pretty-print a structured result without allowing tool text to grow unbounded. */
export function formatStructuredResult(
  value: unknown,
  maxBytes = 16 * 1024,
): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    // Report through the stable placeholder below.
  }
  if (json === undefined) {
    return "[structured result could not be serialized]";
  }
  const totalBytes = Buffer.byteLength(json, "utf8");
  if (totalBytes <= maxBytes) return json;
  const marker = `\n[structured result truncated: ${totalBytes} bytes total]`;
  return `${truncateUtf8(
    json,
    Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8")),
  )}${marker}`;
}

/** Preserve small detail values and replace large ones with a bounded preview. */
export function structuredResultDetails(value: unknown, maxBytes = 4 * 1024) {
  if (value === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return {
      truncated: true,
      reason: "structured result was not serializable",
    };
  }
  if (json === undefined) return undefined;
  const totalBytes = Buffer.byteLength(json, "utf8");
  if (totalBytes <= maxBytes) return value;
  return {
    truncated: true,
    totalBytes,
    // JSON escaping can expand this string, so reserve a conservative factor.
    preview: truncateUtf8(json, Math.max(32, Math.floor(maxBytes / 8))),
  };
}

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
  structured?: unknown;
  schemaError?: string;
}) {
  const maxBytes = 32 * 1024;
  const verb = options.status === "error" ? "failed" : "finished";
  let prefix = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) prefix += `\nError: ${options.errorText}`;
  if (options.schemaError) prefix += `\nSchema error: ${options.schemaError}`;
  if (options.structured !== undefined) {
    prefix += `\n\nStructured result:\n\`\`\`json\n${formatStructuredResult(
      options.structured,
      8 * 1024,
    )}\n\`\`\``;
  }

  const separator = "\n\n";
  const marker = "\n[result message output truncated]";
  const remaining =
    maxBytes - Buffer.byteLength(prefix + separator + marker, "utf8");
  const output = truncateUtf8(options.output, Math.max(0, remaining));
  const wasTruncated = output !== options.output;
  return `${prefix}${separator}${output}${wasTruncated ? marker : ""}`;
}
