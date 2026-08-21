import {
  ERROR_TEXT_MAX_BYTES,
  METADATA_TEXT_MAX_BYTES,
  boundText,
  boundedProjectIdentity,
  buildC0Event,
  captureFromBoundedText,
  mergeCapture,
  type BoundedText,
  type C0EventKind,
  type C0PayloadByKind,
  type ContentMode,
  type PendingObservabilityEvent,
} from "../../shared/observability/events.ts";
import type {
  SpawnTask,
  SubagentEvent,
  SubagentIdentity,
  SubagentSnapshot,
  RunOutcome,
  BackendName,
} from "./domain.ts";

function finiteCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function contentBytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function buildAgentEvent<K extends C0EventKind>(options: {
  readonly kind: K;
  readonly identity: SubagentIdentity;
  readonly cwd: string;
  readonly payload: C0PayloadByKind[K];
  readonly fields?: ReadonlyArray<BoundedText>;
  readonly toolCallId?: string;
  readonly contentMode?: ContentMode;
  readonly occurredAt?: number;
}): PendingObservabilityEvent<K, C0PayloadByKind[K]> {
  const { project, rootField } = boundedProjectIdentity(options.cwd);
  const traceId = boundText(
    options.identity.traceId,
    METADATA_TEXT_MAX_BYTES,
    "ids.traceId",
  );
  const runId = boundText(
    options.identity.runId,
    METADATA_TEXT_MAX_BYTES,
    "ids.runId",
  );
  const parentRunId = boundText(
    options.identity.parentRunId,
    METADATA_TEXT_MAX_BYTES,
    "ids.parentRunId",
  );
  const agentId = boundText(
    options.identity.agentId,
    METADATA_TEXT_MAX_BYTES,
    "ids.agentId",
  );
  const turnId = boundText(
    options.identity.turnId,
    METADATA_TEXT_MAX_BYTES,
    "ids.turnId",
  );
  const toolCallId = options.toolCallId
    ? boundText(options.toolCallId, METADATA_TEXT_MAX_BYTES, "ids.toolCallId")
    : undefined;
  const fields = [
    ...(options.fields ?? []),
    rootField,
    traceId,
    runId,
    parentRunId,
    agentId,
    turnId,
    ...(toolCallId ? [toolCallId] : []),
  ];
  const contentMode = options.contentMode ?? "metadata";
  return buildC0Event({
    kind: options.kind,
    ids: {
      traceId: traceId.value,
      runId: runId.value,
      parentRunId: parentRunId.value,
      agentId: agentId.value,
      turnId: turnId.value,
      ...(toolCallId ? { toolCallId: toolCallId.value } : {}),
    },
    project,
    payload: options.payload,
    capture: mergeCapture(
      contentMode,
      captureFromBoundedText(contentMode, fields),
    ),
    occurredAt: options.occurredAt,
  });
}

export function agentCreatedEvent(
  backend: BackendName,
  task: SpawnTask & { readonly identity: SubagentIdentity },
  occurredAt: number,
) {
  const title = boundText(task.title, METADATA_TEXT_MAX_BYTES, "payload.title");
  const role = task.role
    ? boundText(task.role, METADATA_TEXT_MAX_BYTES, "payload.role")
    : undefined;
  const workflowRunId = task.workflowRunId
    ? boundText(
        task.workflowRunId,
        METADATA_TEXT_MAX_BYTES,
        "payload.workflowRunId",
      )
    : undefined;
  const workflowPhase = task.workflowPhase
    ? boundText(
        task.workflowPhase,
        METADATA_TEXT_MAX_BYTES,
        "payload.workflowPhase",
      )
    : undefined;
  const workflowLabel = task.workflowLabel
    ? boundText(
        task.workflowLabel,
        METADATA_TEXT_MAX_BYTES,
        "payload.workflowLabel",
      )
    : undefined;
  const fields = [
    title,
    role,
    workflowRunId,
    workflowPhase,
    workflowLabel,
  ].filter((field): field is BoundedText => field !== undefined);
  return buildAgentEvent({
    kind: "agent.created",
    identity: task.identity,
    cwd: task.cwd,
    occurredAt,
    fields,
    payload: {
      origin: task.identity.origin,
      backend,
      title: title.value,
      ...(role ? { role: role.value } : {}),
      ...(workflowRunId ? { workflowRunId: workflowRunId.value } : {}),
      ...(task.workflowAgentIndex !== undefined
        ? { workflowAgentIndex: finiteCount(task.workflowAgentIndex) }
        : {}),
      ...(workflowPhase ? { workflowPhase: workflowPhase.value } : {}),
      ...(workflowLabel ? { workflowLabel: workflowLabel.value } : {}),
      resumed: task.resume !== undefined,
    },
  });
}

export function subagentEvent(
  snapshot: SubagentSnapshot,
  event: SubagentEvent,
  runNumber: number,
): PendingObservabilityEvent<C0EventKind> | undefined {
  const base = {
    identity: snapshot.identity,
    cwd: snapshot.cwd,
  } as const;
  switch (event._tag) {
    case "RunStarted":
      return buildAgentEvent({
        ...base,
        kind: "agent.run_started",
        payload: {
          displayId: snapshot.id,
          backend: snapshot.backend,
          turnNumber: Math.max(1, runNumber),
        },
      });
    case "UserMessage":
      return buildAgentEvent({
        ...base,
        kind: "agent.message",
        payload: {
          displayId: snapshot.id,
          messageKind: "user",
          contentUnavailable: true,
          contentBytes: contentBytes(event.text),
        },
      });
    case "AssistantMessage": {
      let textPartCount = 0;
      let thinkingPartCount = 0;
      let toolCallCount = 0;
      let bytes = 0;
      for (const part of event.parts) {
        if (part.type === "toolCall") {
          toolCallCount++;
        } else {
          bytes += contentBytes(part.text);
          if (part.type === "text") textPartCount++;
          else thinkingPartCount++;
        }
      }
      return buildAgentEvent({
        ...base,
        kind: "agent.message",
        payload: {
          displayId: snapshot.id,
          messageKind: "assistant",
          contentUnavailable: true,
          contentBytes: bytes,
          partCount: event.parts.length,
          textPartCount,
          thinkingPartCount,
          toolCallCount,
        },
      });
    }
    case "ToolStart": {
      const name = boundText(
        event.name,
        METADATA_TEXT_MAX_BYTES,
        "payload.name",
      );
      const nativeId = boundText(
        event.toolId,
        METADATA_TEXT_MAX_BYTES,
        "ids.toolCallId.native",
      );
      return buildAgentEvent({
        ...base,
        kind: "agent.tool_started",
        fields: [name, nativeId],
        toolCallId: `${snapshot.identity.agentId}:${nativeId.value}`,
        payload: {
          displayId: snapshot.id,
          name: name.value,
          argumentsUnavailable: true,
        },
      });
    }
    case "ToolEnd": {
      const name = boundText(
        event.name,
        METADATA_TEXT_MAX_BYTES,
        "payload.name",
      );
      const nativeId = boundText(
        event.toolId,
        METADATA_TEXT_MAX_BYTES,
        "ids.toolCallId.native",
      );
      return buildAgentEvent({
        ...base,
        kind: "agent.tool_finished",
        fields: [name, nativeId],
        toolCallId: `${snapshot.identity.agentId}:${nativeId.value}`,
        payload: {
          displayId: snapshot.id,
          name: name.value,
          isError: event.isError,
          resultUnavailable: true,
        },
      });
    }
    case "UsageChanged":
      return buildAgentEvent({
        ...base,
        kind: "agent.usage",
        payload: {
          displayId: snapshot.id,
          ...(finiteCount(event.tokens) !== undefined
            ? { tokens: finiteCount(event.tokens) }
            : {}),
          ...(finiteCount(event.contextWindow) !== undefined
            ? { contextWindow: finiteCount(event.contextWindow) }
            : {}),
          ...(finiteCount(event.inputTokens) !== undefined
            ? { inputTokens: finiteCount(event.inputTokens) }
            : {}),
          ...(finiteCount(event.outputTokens) !== undefined
            ? { outputTokens: finiteCount(event.outputTokens) }
            : {}),
          ...(finiteCount(event.cacheReadTokens) !== undefined
            ? { cacheReadTokens: finiteCount(event.cacheReadTokens) }
            : {}),
          ...(finiteCount(event.cacheWriteTokens) !== undefined
            ? { cacheWriteTokens: finiteCount(event.cacheWriteTokens) }
            : {}),
          ...(event.costUsd !== undefined && Number.isFinite(event.costUsd)
            ? { costUsd: Math.max(0, event.costUsd) }
            : {}),
        },
      });
    case "MetaChanged": {
      const modelLabel = event.meta.modelLabel
        ? boundText(
            event.meta.modelLabel,
            METADATA_TEXT_MAX_BYTES,
            "payload.modelLabel",
          )
        : undefined;
      return buildAgentEvent({
        ...base,
        kind: "agent.meta",
        fields: modelLabel ? [modelLabel] : [],
        payload: {
          displayId: snapshot.id,
          update: "session",
          ...(modelLabel ? { modelLabel: modelLabel.value } : {}),
          ...(finiteCount(event.meta.contextWindow) !== undefined
            ? { contextWindow: finiteCount(event.meta.contextWindow) }
            : {}),
          ...(event.meta.sessionFilePath !== undefined
            ? { hasSessionFile: true }
            : {}),
          ...(event.meta.nativeSessionId !== undefined
            ? { hasNativeSessionId: true }
            : {}),
        },
      });
    }
    case "QueueChanged":
      return buildAgentEvent({
        ...base,
        kind: "agent.meta",
        payload: {
          displayId: snapshot.id,
          update: "queue",
          queuedCount: event.queued.length,
          queuedSteerCount: event.queued.filter(
            (queued) => queued.kind === "steer",
          ).length,
          queuedFollowUpCount: event.queued.filter(
            (queued) => queued.kind === "follow-up",
          ).length,
        },
      });
    case "BackendError": {
      const message = boundText(
        event.message,
        ERROR_TEXT_MAX_BYTES,
        "payload.message",
      );
      return buildAgentEvent({
        ...base,
        kind: "agent.error",
        fields: [message],
        contentMode: "rich",
        payload: {
          displayId: snapshot.id,
          stage: "backend",
          message: message.value,
        },
      });
    }
    case "RunSettled":
    case "AssistantDelta":
    case "ToolUpdate":
      return undefined;
  }
}

function outcomeName(
  outcome: RunOutcome,
): "completed" | "failed" | "interrupted" {
  if (outcome._tag === "Completed") return "completed";
  if (outcome._tag === "Interrupted") return "interrupted";
  return "failed";
}

export function agentSettledEvent(
  snapshot: SubagentSnapshot,
  outcome: RunOutcome,
  turnNumber: number,
  runStartedAt: number,
) {
  const errorValue =
    outcome._tag === "Failed"
      ? outcome.errorText
      : outcome._tag === "Interrupted"
        ? snapshot.errorText
        : undefined;
  const error = errorValue
    ? boundText(errorValue, ERROR_TEXT_MAX_BYTES, "payload.error")
    : undefined;
  const schemaError = snapshot.schemaError
    ? boundText(
        snapshot.schemaError,
        ERROR_TEXT_MAX_BYTES,
        "payload.schemaError",
      )
    : undefined;
  const finalText =
    outcome._tag === "Completed"
      ? outcome.finalText
      : (outcome.partialText ?? "");
  return buildAgentEvent({
    kind: "agent.settled",
    identity: snapshot.identity,
    cwd: snapshot.cwd,
    fields: [error, schemaError].filter(
      (field): field is BoundedText => field !== undefined,
    ),
    contentMode: error || schemaError ? "rich" : "metadata",
    occurredAt: snapshot.settledAt,
    payload: {
      displayId: snapshot.id,
      status: snapshot.status === "done" ? "done" : "error",
      outcome: outcomeName(outcome),
      durationMs: Math.max(
        0,
        (snapshot.settledAt ?? Date.now()) - runStartedAt,
      ),
      turns: Math.max(0, Math.floor(turnNumber)),
      finalTextBytes: contentBytes(finalText),
      hasStructuredResult: snapshot.structured !== undefined,
      ...(schemaError ? { schemaError: schemaError.value } : {}),
      ...(error ? { error: error.value } : {}),
    },
  });
}

export function spawnFailureEvents(options: {
  readonly backend: BackendName;
  readonly task: SpawnTask & { readonly identity: SubagentIdentity };
  readonly createdAt: number;
  readonly message: string;
}): ReadonlyArray<PendingObservabilityEvent<C0EventKind>> {
  const message = boundText(
    options.message,
    ERROR_TEXT_MAX_BYTES,
    "payload.message",
  );
  const now = Date.now();
  const common = {
    identity: options.task.identity,
    cwd: options.task.cwd,
    fields: [message],
    occurredAt: now,
  } as const;
  return [
    buildAgentEvent({
      ...common,
      kind: "agent.error",
      contentMode: "rich",
      payload: { stage: "spawn", message: message.value },
    }),
    buildAgentEvent({
      ...common,
      kind: "agent.settled",
      contentMode: "rich",
      payload: {
        status: "error",
        outcome: "spawn_failed",
        durationMs: Math.max(0, now - options.createdAt),
        turns: 0,
        finalTextBytes: 0,
        hasStructuredResult: false,
        error: message.value,
      },
    }),
  ];
}
