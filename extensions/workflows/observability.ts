import {
  ERROR_TEXT_MAX_BYTES,
  METADATA_TEXT_MAX_BYTES,
  PROMPT_OR_USER_MESSAGE_MAX_BYTES,
  boundText,
  boundedProjectIdentity,
  buildC0Event,
  captureFromBoundedText,
  mergeCapture,
  type BoundedText,
  type C0EventKind,
  type C0PayloadByKind,
  type ContentMode,
} from "../shared/observability/events.ts";
import {
  mintEphemeralParentIdentity,
  parentIdentityFromPiSession,
} from "../shared/observability/ids.ts";
import {
  NOOP_OBSERVABILITY_SINK,
  safeEmit,
  type ObservabilitySink,
} from "../shared/observability/sink.ts";
import {
  countStates,
  WORKFLOW_LOG_ENTRY_MAX_CHARS,
  type WorkflowDetails,
} from "./model.ts";

export interface WorkflowRunEmitter {
  started(details: WorkflowDetails): void;
  phase(details: WorkflowDetails, phase: string): void;
  log(message: string): void;
  settled(details: WorkflowDetails): void;
}

const NOOP_WORKFLOW_RUN_EMITTER: WorkflowRunEmitter = Object.freeze({
  started: (_details: WorkflowDetails) => undefined,
  phase: (_details: WorkflowDetails, _phase: string) => undefined,
  log: (_message: string) => undefined,
  settled: (_details: WorkflowDetails) => undefined,
});

export function createWorkflowRunEmitter(options: {
  readonly runId: string;
  readonly sessionId?: string;
  readonly cwd: string;
  readonly sink?: ObservabilitySink;
  readonly now?: () => number;
}): WorkflowRunEmitter {
  const sink = options.sink ?? NOOP_OBSERVABILITY_SINK;
  if (sink === NOOP_OBSERVABILITY_SINK) return NOOP_WORKFLOW_RUN_EMITTER;

  const now = options.now ?? Date.now;
  const parent = options.sessionId
    ? parentIdentityFromPiSession(options.sessionId)
    : mintEphemeralParentIdentity();
  const { project, rootField } = boundedProjectIdentity(options.cwd);
  const traceId = boundText(
    parent.traceId,
    METADATA_TEXT_MAX_BYTES,
    "ids.traceId",
  );
  const runId = boundText(options.runId, METADATA_TEXT_MAX_BYTES, "ids.runId");
  const parentRunId = boundText(
    parent.rootRunId,
    METADATA_TEXT_MAX_BYTES,
    "ids.parentRunId",
  );
  const envelopeFields = [rootField, traceId, runId, parentRunId];

  const emit = <K extends C0EventKind>(input: {
    readonly kind: K;
    readonly payload: C0PayloadByKind[K];
    readonly fields?: ReadonlyArray<BoundedText>;
    readonly contentMode?: ContentMode;
    readonly occurredAt?: number;
  }) => {
    try {
      const contentMode = input.contentMode ?? "metadata";
      safeEmit(
        sink,
        buildC0Event({
          kind: input.kind,
          ids: {
            traceId: traceId.value,
            runId: runId.value,
            parentRunId: parentRunId.value,
          },
          project,
          payload: input.payload,
          capture: mergeCapture(
            contentMode,
            captureFromBoundedText(contentMode, [
              ...(input.fields ?? []),
              ...envelopeFields,
            ]),
          ),
          occurredAt: input.occurredAt ?? now(),
        }),
      );
    } catch {
      // Event construction is just as non-authoritative as sink delivery.
    }
  };

  return {
    started: (details) => {
      const name = details.name
        ? boundText(details.name, METADATA_TEXT_MAX_BYTES, "payload.name")
        : undefined;
      emit({
        kind: "workflow.started",
        fields: name ? [name] : [],
        occurredAt: details.startedAt,
        payload: {
          ...(name ? { name: name.value } : {}),
          background: details.background,
          phaseCount: details.phases.length,
        },
      });
    },
    phase: (details, value) => {
      const phase = boundText(value, METADATA_TEXT_MAX_BYTES, "payload.phase");
      emit({
        kind: "workflow.phase",
        fields: [phase],
        payload: {
          phase: phase.value,
          knownPhaseCount: details.phases.length,
        },
      });
    },
    log: (value) => {
      const message = boundText(
        value.slice(0, WORKFLOW_LOG_ENTRY_MAX_CHARS),
        PROMPT_OR_USER_MESSAGE_MAX_BYTES,
        "payload.message",
      );
      emit({
        kind: "workflow.log",
        fields: [message],
        contentMode: "rich",
        payload: { message: message.value },
      });
    },
    settled: (details) => {
      const { done, failed } = countStates(details);
      const error = details.error
        ? boundText(details.error, ERROR_TEXT_MAX_BYTES, "payload.error")
        : undefined;
      emit({
        kind: "workflow.settled",
        fields: error ? [error] : [],
        contentMode: error ? "rich" : "metadata",
        occurredAt: details.finishedAt,
        payload: {
          status: details.status === "running" ? "failed" : details.status,
          durationMs: Math.max(
            0,
            (details.finishedAt ?? now()) - details.startedAt,
          ),
          agentCount: details.agents.length,
          completedAgentCount: done,
          failedAgentCount: failed,
          ...(error ? { error: error.value } : {}),
        },
      });
    },
  };
}
