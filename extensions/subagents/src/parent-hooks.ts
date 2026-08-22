import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  OBSERVABILITY_ENVELOPE_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  boundedProjectIdentity,
  type ContentMode,
  type PendingObservabilityEvent,
} from "../../shared/observability/events.ts";
import {
  mintEventId,
  mintTurnId,
  parentIdentityFromPiSession,
  type RootRunId,
  type TraceId,
  type TurnId,
} from "../../shared/observability/ids.ts";
import {
  classifyContentPath,
  resolveProjectPolicy,
} from "../../shared/observability/policy.mjs";
import type { ProducerObservabilitySink } from "./producer-sink.ts";

interface RootIdentity {
  readonly traceId: TraceId;
  readonly rootRunId: RootRunId;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function messageContent(message: unknown) {
  const record = message as
    | {
        role?: unknown;
        content?: unknown;
        usage?: unknown;
        provider?: unknown;
        model?: unknown;
        responseModel?: unknown;
        stopReason?: unknown;
      }
    | undefined;
  const parts = Array.isArray(record?.content) ? record.content : [];
  const text: string[] = [];
  const thinking: string[] = [];
  let imageCount = 0;
  let toolCallCount = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string")
      text.push(value.text);
    else if (
      value.type === "thinking" &&
      value.redacted !== true &&
      typeof value.thinking === "string"
    ) {
      thinking.push(value.thinking);
    } else if (value.type === "image") imageCount++;
    else if (value.type === "toolCall") toolCallCount++;
  }
  return {
    role: record?.role,
    text: text.join("\n"),
    thinking: thinking.join("\n"),
    imageCount,
    toolCallCount,
    usage: record?.usage,
    provider: record?.provider,
    model: record?.responseModel ?? record?.model,
    stopReason: record?.stopReason,
  };
}

/** Retain JSON text/content only; binary image bodies become safe counts. */
function boundedToolValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return { contentUnavailable: true, reason: "depth" };
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 512)
      .map((entry) => boundedToolValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return { contentUnavailable: true, reason: "non-json" };
  }
  const input = value as Record<string, unknown>;
  if (
    input.type === "image" ||
    typeof input.data === "string" ||
    typeof input.source === "object"
  ) {
    return { contentUnavailable: true, reason: "binary" };
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input).slice(0, 256)) {
    output[key] = boundedToolValue(child, depth + 1);
  }
  return output;
}

function knownToolPath(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const record = args as Record<string, unknown>;
  for (const key of [
    "path",
    "file",
    "filePath",
    "file_path",
    "cwd",
    "directory",
  ]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

export function createParentHookObserver(options: {
  getSink: () => ProducerObservabilitySink | undefined;
}) {
  let identity: RootIdentity | undefined;
  let cwd: string | undefined;
  let pendingTurnId: TurnId | undefined;
  let currentTurnId: TurnId | undefined;
  let runStartedAt = 0;
  let settled = false;
  const toolPaths = new Map<string, string | undefined>();

  const diagnostic = (reason: string) => {
    options.getSink()?.recordDiagnostic(reason);
  };

  const safe = (reason: string, operation: () => void) => {
    try {
      operation();
    } catch {
      diagnostic(reason);
    }
  };

  const captureMode = (ctx: ExtensionContext) =>
    options.getSink()?.contentModeFor(ctx.cwd) ?? "disabled";

  const emit = (
    kind: string,
    payload: Record<string, unknown>,
    ctx: ExtensionContext,
    eventOptions: {
      turnId?: string;
      toolCallId?: string;
      contentMode?: ContentMode;
      occurredAt?: number;
    } = {},
  ) => {
    const sink = options.getSink();
    if (!sink || !identity) return;
    const mode = eventOptions.contentMode ?? captureMode(ctx);
    if (mode === "disabled") return;
    const { project } = boundedProjectIdentity(ctx.cwd);
    const event: PendingObservabilityEvent<string, Record<string, unknown>> = {
      v: OBSERVABILITY_ENVELOPE_VERSION,
      eventId: mintEventId(),
      kind,
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      occurredAt: eventOptions.occurredAt ?? Date.now(),
      ids: {
        traceId: identity.traceId,
        runId: identity.rootRunId,
        ...(eventOptions.turnId ? { turnId: eventOptions.turnId } : {}),
        ...(eventOptions.toolCallId
          ? { toolCallId: `${identity.rootRunId}:${eventOptions.toolCallId}` }
          : {}),
      },
      project,
      payload,
      capture: { contentMode: mode, truncated: false },
    };
    sink.emit(event);
  };

  const contentPathPolicy = (
    ctx: ExtensionContext,
    candidate: string | undefined,
  ) => {
    const sink = options.getSink();
    if (!sink || !candidate) {
      return { excluded: false, classification: "unknown" } as const;
    }
    const projectPolicy = resolveProjectPolicy(sink.config, ctx.cwd);
    return classifyContentPath({
      value: candidate,
      cwd: ctx.cwd,
      projectRoot: ctx.cwd,
      excludePaths: projectPolicy.excludePaths,
      // The root covers token/DB/WAL/SHM/state/lock/spool/config/log/export.
      protectedRoots: [sink.paths.root],
      moshiPaths: sink.config.moshiPaths,
    });
  };

  const sessionStart = (event: { reason?: string }, ctx: ExtensionContext) => {
    safe("parent-session-start", () => {
      const sessionId = ctx.sessionManager.getSessionId();
      identity = parentIdentityFromPiSession(sessionId);
      cwd = ctx.cwd;
      pendingTurnId = undefined;
      currentTurnId = undefined;
      runStartedAt = Date.now();
      settled = false;
      toolPaths.clear();
      const usage = ctx.getContextUsage?.();
      emit(
        "run.started",
        {
          runKind: "pi",
          reason: event.reason ?? "startup",
          sessionId,
          model: ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : "unavailable",
          thinkingLevel: ctx.thinkingLevel ?? "off",
          ...(usage
            ? {
                contextTokens: finite(usage.tokens),
                contextWindow: finite(usage.contextWindow),
              }
            : {}),
        },
        ctx,
        { contentMode: "metadata", occurredAt: runStartedAt },
      );
    });
  };

  const sessionShutdown = (
    event: { reason?: string },
    ctx: ExtensionContext,
  ) => {
    safe("parent-session-shutdown", () => {
      if (!identity || settled) return;
      settled = true;
      emit(
        "run.settled",
        {
          status: "completed",
          reason: event.reason ?? "quit",
          durationMs: Math.max(0, Date.now() - runStartedAt),
        },
        ctx,
        { contentMode: "metadata" },
      );
    });
  };

  const register = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event, ctx) => {
      safe("parent-before-agent-start", () => {
        pendingTurnId = mintTurnId();
        const mode = captureMode(ctx);
        const prompt = typeof event.prompt === "string" ? event.prompt : "";
        emit(
          "message.user",
          mode === "rich"
            ? {
                content: prompt,
                imageCount: Array.isArray(event.images)
                  ? event.images.length
                  : 0,
              }
            : {
                contentBytes: Buffer.byteLength(prompt, "utf8"),
                imageCount: Array.isArray(event.images)
                  ? event.images.length
                  : 0,
                contentUnavailable: true,
              },
          ctx,
          { turnId: pendingTurnId, contentMode: mode },
        );
      });
    });

    pi.on("turn_start", (event, ctx) => {
      safe("parent-turn-start", () => {
        currentTurnId = pendingTurnId ?? mintTurnId();
        pendingTurnId = undefined;
        emit(
          "turn.started",
          {
            turnIndex: finite(event.turnIndex) ?? 0,
            model: ctx.model
              ? `${ctx.model.provider}/${ctx.model.id}`
              : "unavailable",
            thinkingLevel: ctx.thinkingLevel ?? "off",
          },
          ctx,
          {
            turnId: currentTurnId,
            contentMode: "metadata",
            occurredAt: finite(event.timestamp) ?? Date.now(),
          },
        );
      });
    });

    pi.on("message_end", (event, ctx) => {
      safe("parent-message-end", () => {
        const content = messageContent(event.message);
        if (content.role !== "assistant") return;
        const mode = captureMode(ctx);
        const common = {
          textBytes: Buffer.byteLength(content.text, "utf8"),
          thinkingBytes: Buffer.byteLength(content.thinking, "utf8"),
          imageCount: content.imageCount,
          toolCallCount: content.toolCallCount,
          provider:
            typeof content.provider === "string"
              ? content.provider
              : "unavailable",
          model:
            typeof content.model === "string" ? content.model : "unavailable",
          stopReason:
            typeof content.stopReason === "string"
              ? content.stopReason
              : "unavailable",
        };
        emit(
          "message.assistant",
          mode === "rich"
            ? {
                ...common,
                ...(content.text ? { content: content.text } : {}),
                ...(content.thinking ? { thinking: content.thinking } : {}),
              }
            : { ...common, contentUnavailable: true },
          ctx,
          { turnId: currentTurnId, contentMode: mode },
        );
      });
    });

    pi.on("tool_execution_start", (event, ctx) => {
      safe("parent-tool-start", () => {
        const candidate = knownToolPath(event.args);
        toolPaths.set(event.toolCallId, candidate);
        const policy = contentPathPolicy(ctx, candidate);
        if (policy.classification === "protected") return;
        const mode = captureMode(ctx);
        emit(
          "tool.started",
          policy.excluded || mode !== "rich"
            ? {
                name: event.toolName,
                operation: "execute",
                classification: policy.classification,
                argumentsUnavailable: true,
                ...(policy.excluded ? { contentOmitted: true } : {}),
              }
            : {
                name: event.toolName,
                operation: "execute",
                classification: policy.classification,
                arguments: boundedToolValue(event.args),
              },
          ctx,
          {
            turnId: currentTurnId,
            toolCallId: event.toolCallId,
            contentMode: mode,
          },
        );
      });
    });

    pi.on("tool_execution_end", (event, ctx) => {
      safe("parent-tool-end", () => {
        const candidate = toolPaths.get(event.toolCallId);
        toolPaths.delete(event.toolCallId);
        const policy = contentPathPolicy(ctx, candidate);
        if (policy.classification === "protected") return;
        const mode = captureMode(ctx);
        emit(
          "tool.finished",
          policy.excluded || mode !== "rich"
            ? {
                name: event.toolName,
                operation: "execute",
                classification: policy.classification,
                isError: event.isError,
                resultUnavailable: true,
                ...(policy.excluded ? { contentOmitted: true } : {}),
              }
            : {
                name: event.toolName,
                operation: "execute",
                classification: policy.classification,
                isError: event.isError,
                result: boundedToolValue(event.result),
              },
          ctx,
          {
            turnId: currentTurnId,
            toolCallId: event.toolCallId,
            contentMode: mode,
          },
        );
      });
    });

    pi.on("turn_end", (event, ctx) => {
      safe("parent-turn-end", () => {
        const usage = ctx.getContextUsage?.();
        const message = messageContent(event.message);
        emit(
          "turn.settled",
          {
            turnIndex: finite(event.turnIndex) ?? 0,
            toolResultCount: Array.isArray(event.toolResults)
              ? event.toolResults.length
              : 0,
            model: ctx.model
              ? `${ctx.model.provider}/${ctx.model.id}`
              : "unavailable",
            thinkingLevel: ctx.thinkingLevel ?? "off",
            stopReason:
              typeof message.stopReason === "string"
                ? message.stopReason
                : "unavailable",
            ...(usage
              ? {
                  contextTokens: finite(usage.tokens),
                  contextWindow: finite(usage.contextWindow),
                }
              : {}),
          },
          ctx,
          { turnId: currentTurnId, contentMode: "metadata" },
        );
        currentTurnId = undefined;
      });
    });

    pi.on("session_compact", (event, ctx) => {
      safe("parent-session-compact", () => {
        const entry = event.compactionEntry as
          { tokensBefore?: unknown; summary?: unknown } | undefined;
        emit(
          "session.compacted",
          {
            reason: event.reason,
            willRetry: event.willRetry,
            fromExtension: event.fromExtension,
            tokensBefore: finite(entry?.tokensBefore),
            summaryBytes:
              typeof entry?.summary === "string"
                ? Buffer.byteLength(entry.summary, "utf8")
                : 0,
          },
          ctx,
          { contentMode: "metadata" },
        );
      });
    });
  };

  return Object.freeze({
    register,
    sessionStart,
    sessionShutdown,
    get state() {
      return { identity, cwd, pendingTurnId, currentTurnId, settled } as const;
    },
  });
}

export type ParentHookObserver = ReturnType<typeof createParentHookObserver>;
