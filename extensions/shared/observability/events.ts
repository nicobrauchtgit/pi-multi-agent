import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mintEventId, type EventId, type ProducerId } from "./ids.ts";

export const OBSERVABILITY_ENVELOPE_VERSION = 1 as const;
export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;

export const OBSERVABILITY_EVENT_KINDS = [
  "run.started",
  "turn.started",
  "message.user",
  "message.assistant",
  "tool.started",
  "tool.finished",
  "turn.settled",
  "run.settled",
  "session.compacted",
  "agent.created",
  "agent.run_started",
  "agent.message",
  "agent.tool_started",
  "agent.tool_finished",
  "agent.usage",
  "agent.meta",
  "agent.error",
  "agent.settled",
  "workflow.started",
  "workflow.phase",
  "workflow.log",
  "workflow.settled",
  "artifact.observed",
  "artifact.recovered",
  "telemetry.dropped",
  "telemetry.spool_overflow",
  "telemetry.rejected",
] as const;

export type ObservabilityEventKind = (typeof OBSERVABILITY_EVENT_KINDS)[number];

/** The only kinds emitted by C0 code. Later stages may widen this allowlist. */
export const C0_EMITTED_KINDS = [
  "agent.created",
  "agent.run_started",
  "agent.message",
  "agent.tool_started",
  "agent.tool_finished",
  "agent.usage",
  "agent.meta",
  "agent.error",
  "agent.settled",
  "workflow.started",
  "workflow.phase",
  "workflow.log",
  "workflow.settled",
] as const satisfies ReadonlyArray<ObservabilityEventKind>;

export type C0EventKind = (typeof C0_EMITTED_KINDS)[number];

export const PROMPT_OR_USER_MESSAGE_MAX_BYTES = 64 * 1024;
export const ASSISTANT_MESSAGE_MAX_BYTES = 128 * 1024;
export const TOOL_ARGUMENTS_MAX_BYTES = 64 * 1024;
export const TOOL_RESULT_MAX_BYTES = 128 * 1024;
export const STRUCTURED_RESULT_MAX_BYTES = 256 * 1024;
export const PATCH_OR_DIFF_MAX_BYTES = 256 * 1024;
export const EVENT_CONTENT_MAX_BYTES = 256 * 1024;
export const EVENT_ENVELOPE_MAX_BYTES = 128 * 1024;
export const STORED_EVENT_MAX_BYTES = 512 * 1024;
export const INGEST_BATCH_MAX_BYTES = 2 * 1024 * 1024;
export const INGEST_BATCH_MAX_EVENTS = 128;

/** C0 metadata strings are intentionally much smaller than the v1 allowance. */
export const METADATA_TEXT_MAX_BYTES = 4 * 1024;
export const ERROR_TEXT_MAX_BYTES = PROMPT_OR_USER_MESSAGE_MAX_BYTES;

export type ContentMode = "rich" | "metadata" | "disabled";

export interface ObservabilityIds {
  readonly traceId?: string;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
}

export interface ObservabilityProject {
  readonly id: string;
  readonly root: string;
}

export interface ObservabilityCapture {
  readonly contentMode: ContentMode;
  readonly truncated: boolean;
  readonly truncatedFields?: ReadonlyArray<string>;
  readonly fieldBytes?: Readonly<
    Record<string, { readonly original: number; readonly stored: number }>
  >;
}

export interface PendingObservabilityEvent<
  K extends string = ObservabilityEventKind,
  P = unknown,
> {
  readonly v: typeof OBSERVABILITY_ENVELOPE_VERSION;
  readonly eventId: EventId;
  readonly kind: K;
  readonly schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  readonly occurredAt: number;
  readonly ids: ObservabilityIds;
  readonly project?: ObservabilityProject;
  readonly payload: P;
  readonly capture: ObservabilityCapture;
}

export interface ObservabilityEvent<
  K extends string = string,
  P = unknown,
> extends PendingObservabilityEvent<K, P> {
  readonly producer: {
    readonly id: ProducerId;
    readonly seq: number;
    readonly kind: "pi";
  };
}

export interface AgentCreatedPayload {
  readonly origin: "model" | "btw" | "workflow";
  readonly backend: "pi" | "claude" | "codex";
  readonly title: string;
  readonly role?: string;
  readonly workflowRunId?: string;
  readonly workflowAgentIndex?: number;
  readonly workflowPhase?: string;
  readonly workflowLabel?: string;
  readonly resumed: boolean;
}

export interface AgentRunStartedPayload {
  readonly displayId: string;
  readonly backend: "pi" | "claude" | "codex";
  readonly turnNumber: number;
}

export interface AgentMessagePayload {
  readonly displayId: string;
  readonly messageKind: "user" | "assistant";
  readonly contentUnavailable: true;
  readonly contentBytes: number;
  readonly partCount?: number;
  readonly textPartCount?: number;
  readonly thinkingPartCount?: number;
  readonly toolCallCount?: number;
}

export interface AgentToolStartedPayload {
  readonly displayId: string;
  readonly name: string;
  readonly argumentsUnavailable: true;
}

export interface AgentToolFinishedPayload {
  readonly displayId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly resultUnavailable: true;
}

export interface AgentUsagePayload {
  readonly displayId: string;
  readonly tokens?: number;
  readonly contextWindow?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

export interface AgentMetaPayload {
  readonly displayId: string;
  readonly update: "session" | "queue";
  readonly modelLabel?: string;
  readonly contextWindow?: number;
  readonly hasSessionFile?: boolean;
  readonly hasNativeSessionId?: boolean;
  readonly queuedCount?: number;
  readonly queuedSteerCount?: number;
  readonly queuedFollowUpCount?: number;
}

export interface AgentErrorPayload {
  readonly displayId?: string;
  readonly stage: "spawn" | "backend";
  readonly message: string;
}

export interface AgentSettledPayload {
  readonly displayId?: string;
  readonly status: "done" | "error";
  readonly outcome: "completed" | "failed" | "interrupted" | "spawn_failed";
  /** Duration of the native run that produced this settlement. */
  readonly durationMs: number;
  /** Cumulative native RunStarted count; matches run_started.turnNumber. */
  readonly turns: number;
  /** UTF-8 size of the backend outcome text before snapshot preview truncation. */
  readonly finalTextBytes: number;
  readonly hasStructuredResult: boolean;
  readonly schemaError?: string;
  readonly error?: string;
}

export interface WorkflowStartedPayload {
  readonly name?: string;
  readonly background: boolean;
  readonly phaseCount: number;
}

export interface WorkflowPhasePayload {
  readonly phase: string;
  readonly knownPhaseCount: number;
}

export interface WorkflowLogPayload {
  readonly message: string;
}

export interface WorkflowSettledPayload {
  readonly status: "completed" | "failed" | "aborted";
  readonly durationMs: number;
  readonly agentCount: number;
  readonly completedAgentCount: number;
  readonly failedAgentCount: number;
  readonly error?: string;
}

type AdditivePayload<T> = T & Readonly<Record<string, unknown>>;

export interface C0PayloadByKind {
  readonly "agent.created": AdditivePayload<AgentCreatedPayload>;
  readonly "agent.run_started": AdditivePayload<AgentRunStartedPayload>;
  readonly "agent.message": AdditivePayload<AgentMessagePayload>;
  readonly "agent.tool_started": AdditivePayload<AgentToolStartedPayload>;
  readonly "agent.tool_finished": AdditivePayload<AgentToolFinishedPayload>;
  readonly "agent.usage": AdditivePayload<AgentUsagePayload>;
  readonly "agent.meta": AdditivePayload<AgentMetaPayload>;
  readonly "agent.error": AdditivePayload<AgentErrorPayload>;
  readonly "agent.settled": AdditivePayload<AgentSettledPayload>;
  readonly "workflow.started": AdditivePayload<WorkflowStartedPayload>;
  readonly "workflow.phase": AdditivePayload<WorkflowPhasePayload>;
  readonly "workflow.log": AdditivePayload<WorkflowLogPayload>;
  readonly "workflow.settled": AdditivePayload<WorkflowSettledPayload>;
}

export interface BoundedText {
  readonly value: string;
  readonly path: string;
  /** JSON-encoded UTF-8 bytes, including string quotes and escaping. */
  readonly originalBytes: number;
  readonly storedBytes: number;
  readonly truncated: boolean;
}

function encodedStringBytes(value: string) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function utf8Prefix(value: string, rawBytes: number) {
  const buffer = Buffer.from(value, "utf8");
  if (rawBytes >= buffer.length) return value;
  let end = Math.max(0, rawBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** Bound one JSON string field without retaining a partial UTF-8 code point. */
export function boundText(
  value: string,
  maxEncodedBytes: number,
  path: string,
): BoundedText {
  const originalBytes = encodedStringBytes(value);
  if (originalBytes <= maxEncodedBytes) {
    return {
      value,
      path,
      originalBytes,
      storedBytes: originalBytes,
      truncated: false,
    };
  }

  const rawBytes = Buffer.byteLength(value, "utf8");
  let low = 0;
  let high = rawBytes;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(value, middle);
    if (encodedStringBytes(candidate) <= maxEncodedBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const storedBytes = encodedStringBytes(best);
  return {
    value: best,
    path,
    originalBytes,
    storedBytes,
    truncated: true,
  };
}

export function captureFromBoundedText(
  contentMode: ContentMode,
  fields: ReadonlyArray<BoundedText>,
): ObservabilityCapture {
  const truncated = fields.filter((field) => field.truncated);
  if (truncated.length === 0) return { contentMode, truncated: false };
  return {
    contentMode,
    truncated: true,
    truncatedFields: truncated.map((field) => field.path),
    fieldBytes: Object.fromEntries(
      truncated.map((field) => [
        field.path,
        { original: field.originalBytes, stored: field.storedBytes },
      ]),
    ),
  };
}

export function mergeCapture(
  contentMode: ContentMode,
  ...captures: ReadonlyArray<ObservabilityCapture>
): ObservabilityCapture {
  const truncatedFields = captures.flatMap(
    (capture) => capture.truncatedFields ?? [],
  );
  if (truncatedFields.length === 0) return { contentMode, truncated: false };
  return {
    contentMode,
    truncated: true,
    truncatedFields: [...new Set(truncatedFields)],
    fieldBytes: Object.assign(
      {},
      ...captures.map((capture) => capture.fieldBytes ?? {}),
    ),
  };
}

const PROJECT_IDENTITY_CACHE_MAX = 256;
const projectIdentityCache = new Map<string, ObservabilityProject>();

function projectForStoredRoot(root: string): ObservabilityProject {
  return {
    id: `sha256:${createHash("sha256").update(root).digest("hex")}`,
    root,
  };
}

/** Resolve existing project roots through symlinks before deriving their ID. */
export function projectIdentity(root: string): ObservabilityProject {
  const resolved = path.resolve(root);
  const cached = projectIdentityCache.get(resolved);
  if (cached) return cached;

  let canonicalRoot = resolved;
  try {
    canonicalRoot = fs.realpathSync.native(resolved);
  } catch {
    // Event construction is best-effort; nonexistent test paths stay resolved.
  }
  const project = projectForStoredRoot(canonicalRoot);
  if (projectIdentityCache.size >= PROJECT_IDENTITY_CACHE_MAX) {
    const oldest = projectIdentityCache.keys().next().value;
    if (oldest !== undefined) projectIdentityCache.delete(oldest);
  }
  projectIdentityCache.set(resolved, project);
  return project;
}

/**
 * Canonicalize and bound a project root, then hash the exact stored root so
 * `project.id` is always recomputable from `project.root`.
 */
export function boundedProjectIdentity(
  root: string,
  maxEncodedBytes = METADATA_TEXT_MAX_BYTES,
): { readonly project: ObservabilityProject; readonly rootField: BoundedText } {
  const canonical = projectIdentity(root);
  const rootField = boundText(canonical.root, maxEncodedBytes, "project.root");
  return {
    project: projectForStoredRoot(rootField.value),
    rootField,
  };
}

export function buildC0Event<K extends C0EventKind>(input: {
  readonly kind: K;
  readonly ids: ObservabilityIds;
  readonly project?: ObservabilityProject;
  readonly payload: C0PayloadByKind[K];
  readonly capture?: ObservabilityCapture;
  readonly occurredAt?: number;
  readonly eventId?: EventId;
}): PendingObservabilityEvent<K, C0PayloadByKind[K]> {
  return {
    v: OBSERVABILITY_ENVELOPE_VERSION,
    eventId: input.eventId ?? mintEventId(),
    kind: input.kind,
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    occurredAt: input.occurredAt ?? Date.now(),
    ids: input.ids,
    ...(input.project ? { project: input.project } : {}),
    payload: input.payload,
    capture: input.capture ?? { contentMode: "metadata", truncated: false },
  };
}

/** Recording/test-only estimate. Production C0's no-op path never stringifies. */
export function estimateEventBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
