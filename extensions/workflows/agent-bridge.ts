import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  codexJsonSchemaCompatibilityError,
  jsonSchemaValidationError,
} from "../shared/json-schema.ts";
import { assertChildWorkingDirectoryAllowed } from "../shared/child-session.ts";
import { ensureBlackboard, withBlackboard } from "../shared/hunk-blackboard.ts";
import { truncateUtf8 } from "../shared/text.ts";
import type { ProcessServiceHandle } from "../shared/service-registry.ts";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  latestText,
  type BackendName,
  type ParentContext,
  type ReasoningEffort,
  type SubagentSnapshot,
  type TranscriptItem,
} from "../subagents/src/domain.ts";
import type {
  CollectedWorkflowSettlement,
  SubagentManagerShape,
} from "../subagents/src/manager.ts";
import type { SubagentRuntime } from "../subagents/src/runtime.ts";
import { buildWorkflowAgentPrompt } from "./prompt.ts";
import { emptyUsage, type AgentRecord, type TranscriptEntry } from "./model.ts";

export const WORKFLOW_RESPONSE_STALL_MS = 45_000;
const PREVIEW_MAX_BYTES = 1_024;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1_024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1_024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export interface WorkflowAgentCallOptions {
  readonly harness?: unknown;
  readonly label?: unknown;
  readonly phase?: unknown;
  readonly schema?: unknown;
  readonly model?: unknown;
  readonly provider?: unknown;
  readonly effort?: unknown;
}

export interface ScriptAgentResult {
  readonly ok: boolean;
  readonly output: string;
  readonly structured?: unknown;
  readonly error?: string;
}

export interface WorkflowAgentBridgeContext {
  readonly service: ProcessServiceHandle<SubagentRuntime, SubagentManagerShape>;
  readonly runId: string;
  readonly cwd: string;
  readonly parent: ParentContext;
  readonly record: AgentRecord;
  readonly signal: AbortSignal;
  readonly onUpdate: () => void;
  readonly responseStallMs?: number;
}

function errorText(error: unknown) {
  return truncateUtf8(
    error instanceof Error ? error.message : String(error),
    16 * 1_024,
  );
}

function finite(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function transcriptTiming(items: ReadonlyArray<TranscriptItem>) {
  const timings = new Map<
    string,
    Pick<TranscriptEntry, "startedAt" | "finishedAt" | "durationMs">
  >();
  for (const item of items) {
    if (item.kind !== "toolResult") continue;
    timings.set(item.toolId, {
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      durationMs: item.durationMs,
    });
  }
  return timings;
}

/** Pure bounded manager-snapshot adapter used by live UI and artifacts. */
export function transcriptFromManagerSnapshot(
  snapshot: SubagentSnapshot,
): TranscriptEntry[] {
  const timings = transcriptTiming(snapshot.transcript);
  const entries: TranscriptEntry[] = [];
  for (const item of snapshot.transcript) {
    if (item.kind === "user") {
      entries.push({
        role: "user",
        text: item.text,
        timestamp: item.timestamp,
      });
      continue;
    }
    if (item.kind === "assistant") {
      for (const part of item.parts) {
        if (part.type === "text") {
          if (part.text.trim()) {
            entries.push({
              role: "assistant",
              text: part.text,
              timestamp: item.timestamp,
            });
          }
        } else if (part.type === "thinking") {
          if (part.text.trim() || part.redacted) {
            entries.push({
              role: "thinking",
              text: part.redacted ? "[redacted thinking]" : part.text,
              timestamp: item.timestamp,
            });
          }
        } else {
          entries.push({
            role: "tool",
            name: part.name,
            text: part.argsPreview ?? "{}",
            toolCallId: part.toolId,
            timestamp: item.timestamp,
            ...timings.get(part.toolId),
          });
        }
      }
      continue;
    }
    entries.push({
      role: "toolResult",
      name: item.name,
      text: item.outputPreview ?? "(result unavailable)",
      toolCallId: item.toolId,
      isError: item.isError,
      timestamp: item.timestamp,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      durationMs: item.durationMs,
    });
  }

  const selected =
    entries.length <= TRANSCRIPT_MAX_ENTRIES
      ? entries
      : [entries[0], ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
  const bounded: TranscriptEntry[] = [];
  let totalBytes = 0;
  for (const entry of selected) {
    const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(
      entry.text,
      Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
    );
    totalBytes += Buffer.byteLength(text, "utf8");
    bounded.push({
      ...entry,
      text:
        text === entry.text ? text : `${text}\n[transcript entry truncated]`,
    });
  }
  if (bounded.length < entries.length) {
    bounded.push({
      role: "toolResult",
      name: "transcript",
      text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]`,
    });
  }
  return bounded;
}

export function applyManagerSnapshotToAgentRecord(
  record: AgentRecord,
  snapshot: SubagentSnapshot,
) {
  record.displayId = snapshot.id;
  record.agentId = snapshot.identity.agentId;
  record.harness = snapshot.backend;
  if (snapshot.meta.modelLabel === undefined) delete record.model;
  else record.model = snapshot.meta.modelLabel;
  const contextWindow =
    snapshot.meta.contextWindow ?? snapshot.usage.contextWindow;
  if (contextWindow === undefined) delete record.contextWindow;
  else record.contextWindow = contextWindow;
  record.startedAt = snapshot.createdAt;
  if (snapshot.settledAt === undefined) delete record.finishedAt;
  else record.finishedAt = snapshot.settledAt;
  record.state =
    snapshot.status === "running"
      ? "running"
      : snapshot.status === "done"
        ? "done"
        : "error";
  if (snapshot.errorText === undefined) delete record.error;
  else record.error = snapshot.errorText;
  if (snapshot.schemaError === undefined) delete record.schemaError;
  else record.schemaError = snapshot.schemaError;
  // The validated value is returned directly to the workflow script. Mirroring
  // it into every UI/artifact record bloats checkpoints and is not rendered.
  record.preview = truncateUtf8(latestText(snapshot), PREVIEW_MAX_BYTES);
  record.usage = {
    input: finite(snapshot.usage.inputTokens),
    output: finite(snapshot.usage.outputTokens),
    cacheRead: finite(snapshot.usage.cacheReadTokens),
    cacheWrite: finite(snapshot.usage.cacheWriteTokens),
    cost: finite(snapshot.usage.costUsd),
    ...(snapshot.usage.tokens === undefined
      ? {}
      : { contextTokens: finite(snapshot.usage.tokens) }),
    turns: Math.max(0, Math.floor(snapshot.turns)),
  };
  record.transcript = transcriptFromManagerSnapshot(snapshot);
  return record;
}

function resolveHarness(value: unknown): BackendName {
  if (value === undefined) return "pi";
  if (
    typeof value === "string" &&
    (BACKEND_NAMES as readonly string[]).includes(value)
  ) {
    return value as BackendName;
  }
  throw new Error(
    `invalid harness "${String(value)}" (use ${BACKEND_NAMES.join("|")})`,
  );
}

function resolveEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  const effort = String(value);
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `invalid effort "${effort}" (use ${REASONING_EFFORTS.join("|")})`,
    );
  }
  return effort as ReasoningEffort;
}

function resolveModel(options: {
  harness: BackendName;
  model: unknown;
  provider: unknown;
  registry?: ModelRegistry;
}) {
  const provider =
    options.provider === undefined
      ? undefined
      : typeof options.provider === "string"
        ? options.provider.trim()
        : undefined;
  const model =
    options.model === undefined
      ? undefined
      : typeof options.model === "string"
        ? options.model.trim()
        : undefined;
  if (options.provider !== undefined && !provider) {
    throw new Error("provider must be a non-empty string");
  }
  if (options.model !== undefined && !model) {
    throw new Error("model must be a non-empty string");
  }
  if (options.harness !== "pi" && provider !== undefined) {
    throw new Error(
      `provider is supported only with harness "pi"; ${options.harness} models use their native alias/slug`,
    );
  }
  if (provider !== undefined) {
    if (!model) throw new Error("`provider` requires `model` as well");
    const resolved = options.registry?.find(provider, model);
    if (!resolved) throw new Error(`unknown model "${provider}/${model}"`);
    return `${resolved.provider}/${resolved.id}`;
  }
  return model;
}

function validateSchema(schema: unknown, harness: BackendName) {
  if (schema === undefined) return;
  const error = jsonSchemaValidationError(schema);
  if (error) throw new Error(`Invalid structured output schema: ${error}.`);
  if (harness === "codex") {
    const compatibilityError = codexJsonSchemaCompatibilityError(schema);
    if (compatibilityError) {
      throw new Error(
        `Codex structured output schema is unsupported: ${compatibilityError}.`,
      );
    }
  }
}

function hasAssistantResponse(snapshot: SubagentSnapshot) {
  if (snapshot.liveAssistant?.text || snapshot.liveAssistant?.thinking) {
    return true;
  }
  return snapshot.transcript.some((item) => item.kind === "assistant");
}

function failedResult(
  context: WorkflowAgentBridgeContext,
  message: string,
  output = "",
): ScriptAgentResult {
  context.record.state = "error";
  context.record.error = message;
  context.record.finishedAt = Date.now();
  context.record.preview = truncateUtf8(output, PREVIEW_MAX_BYTES);
  context.onUpdate();
  return { ok: false, output, error: message };
}

function settlementResult(
  settlement: CollectedWorkflowSettlement,
): ScriptAgentResult {
  const { snapshot, outcome } = settlement;
  if (settlement.collectionError) {
    return {
      ok: false,
      output: snapshot.finalText,
      error: settlement.collectionError,
    };
  }
  if (outcome._tag === "Completed") {
    return {
      ok: true,
      output: outcome.finalText,
      ...(outcome.structured === undefined
        ? {}
        : { structured: outcome.structured }),
    };
  }
  if (outcome._tag === "Interrupted") {
    return {
      ok: false,
      output: outcome.partialText ?? snapshot.finalText,
      error: outcome.errorText ?? "Agent was aborted",
    };
  }
  const schemaSuffix = outcome.schemaError
    ? ` (schema: ${outcome.schemaError})`
    : "";
  return {
    ok: false,
    output: outcome.partialText ?? snapshot.finalText,
    error: `${outcome.errorText}${schemaSuffix}`,
  };
}

/** Execute one DSL agent() through the process-owned SubagentManager. */
export async function executeManagerWorkflowAgent(
  promptValue: unknown,
  options: WorkflowAgentCallOptions,
  context: WorkflowAgentBridgeContext,
): Promise<ScriptAgentResult> {
  let harness: BackendName;
  let effort: ReasoningEffort | undefined;
  let model: string | undefined;
  try {
    harness = resolveHarness(options.harness);
    effort = resolveEffort(options.effort);
    model = resolveModel({
      harness,
      model: options.model,
      provider: options.provider,
      registry: context.parent.modelRegistry,
    });
    validateSchema(options.schema, harness);
    assertChildWorkingDirectoryAllowed(context.cwd);
  } catch (error) {
    return failedResult(
      context,
      `agent "${context.record.label}": ${errorText(error)}`,
    );
  }

  context.record.harness = harness;
  context.record.model =
    model ?? (harness === "pi" ? context.parent.inheritedModel?.id : undefined);
  context.record.usage = context.record.usage ?? emptyUsage();
  context.onUpdate();

  const rawPrompt =
    typeof promptValue === "string" ? promptValue : String(promptValue ?? "");
  if (!rawPrompt.trim()) {
    return failedResult(context, "agent() requires a non-empty prompt string");
  }
  if (!context.service.isCurrent()) {
    return failedResult(context, "Subagent service was reloaded");
  }
  if (context.signal.aborted) {
    return failedResult(context, "Agent was aborted");
  }

  let prompt = buildWorkflowAgentPrompt(rawPrompt);
  try {
    const blackboard = await ensureBlackboard(context.cwd, { refresh: true });
    prompt = withBlackboard(prompt, blackboard);
  } catch {
    // Hunk remains a best-effort side-channel.
  }

  const manager = await context.service.manager;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let managerId: string | undefined;
  let stalledError: string | undefined;
  const combinedAbort = new AbortController();
  const abortFromInvocation = () =>
    combinedAbort.abort(
      context.signal.reason ?? new Error("Agent was aborted"),
    );
  const abortFromService = () =>
    combinedAbort.abort(
      context.service.shutdownSignal.reason ??
        new Error("Subagent service was reloaded"),
    );
  context.signal.addEventListener("abort", abortFromInvocation, { once: true });
  context.service.shutdownSignal.addEventListener("abort", abortFromService, {
    once: true,
  });
  if (context.signal.aborted) abortFromInvocation();
  if (context.service.shutdownSignal.aborted) abortFromService();

  const clearWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const syncSnapshot = (snapshot: SubagentSnapshot) => {
    applyManagerSnapshotToAgentRecord(context.record, snapshot);
    if (hasAssistantResponse(snapshot)) clearWatchdog();
    context.onUpdate();
  };

  try {
    const effect = manager.runWorkflowAgent(
      harness,
      {
        prompt,
        title: context.record.label,
        cwd: context.cwd,
        schema: options.schema,
        model,
        reasoningEffort: effort,
        workflowRunId: context.runId,
        workflowAgentIndex: context.record.index,
        workflowPhase: context.record.phase,
        workflowLabel: context.record.label,
        parent: context.parent,
      },
      {
        signal: combinedAbort.signal,
        onAdmissionWait: () => {
          context.record.preview = "Waiting for a global subagent slot…";
          context.onUpdate();
        },
        onSpawned: (snapshot) => {
          managerId = snapshot.id;
          syncSnapshot(snapshot);
          unsubscribe = manager.view.subscribeTo(snapshot.id, () => {
            const current = manager.view.get(snapshot.id);
            if (current) syncSnapshot(current);
          });
          const timeoutMs = Math.max(
            1,
            context.responseStallMs ?? WORKFLOW_RESPONSE_STALL_MS,
          );
          timer = setTimeout(() => {
            const modelLabel =
              manager.view.get(snapshot.id)?.meta.modelLabel ?? model;
            const modelText = modelLabel ? ` for ${modelLabel}` : "";
            stalledError = `Agent received no assistant response event${modelText} within ${
              timeoutMs % 1_000 === 0
                ? `${timeoutMs / 1_000} seconds`
                : `${timeoutMs} ms`
            }; the provider request may be stalled. Retry the workflow.`;
            combinedAbort.abort(new Error(stalledError));
          }, timeoutMs);
          timer.unref?.();
        },
      },
    );
    const settlement = await context.service.runtime.runPromise(effect);
    syncSnapshot(settlement.snapshot);
    if (stalledError) {
      return failedResult(context, stalledError, settlement.snapshot.finalText);
    }
    if (!context.service.isCurrent()) {
      return failedResult(
        context,
        "Subagent service was reloaded",
        settlement.snapshot.finalText,
      );
    }
    const result = settlementResult(settlement);
    context.record.state = result.ok ? "done" : "error";
    if (result.error === undefined) delete context.record.error;
    else context.record.error = result.error;
    context.record.finishedAt = settlement.snapshot.settledAt ?? Date.now();
    context.onUpdate();
    return result;
  } catch (error) {
    const message =
      stalledError ??
      (combinedAbort.signal.aborted
        ? context.service.isCurrent()
          ? "Agent was aborted"
          : "Subagent service was reloaded"
        : `agent "${context.record.label}": ${errorText(error)}`);
    const output = managerId
      ? (manager.view.get(managerId)?.finalText ?? "")
      : "";
    return failedResult(context, message, output);
  } finally {
    clearWatchdog();
    unsubscribe?.();
    context.signal.removeEventListener("abort", abortFromInvocation);
    context.service.shutdownSignal.removeEventListener(
      "abort",
      abortFromService,
    );
  }
}
