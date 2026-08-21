/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import { isDeepStrictEqual } from "node:util";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  RoleLeaseHandle,
  SpawnTask,
  SubagentEvent,
  SubagentIdentity,
  SubagentOrigin,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  SendError,
  SpawnError,
} from "./domain.ts";
import {
  mintAgentId,
  mintEphemeralParentIdentity,
  mintStandaloneRunId,
  mintTurnId,
  type TurnId,
} from "../../shared/observability/ids.ts";
import {
  NOOP_OBSERVABILITY_SINK,
  NoopObservabilitySinkLayer,
  ObservabilitySinkService,
  safeEmit,
} from "../../shared/observability/sink.ts";
import {
  agentCreatedEvent,
  agentSettledEvent,
  spawnFailureEvents,
  subagentEvent,
} from "./observability.ts";
import {
  JSON_SCHEMA_MAX_BYTES,
  STRUCTURED_OUTPUT_MAX_BYTES,
} from "../../shared/json-schema.ts";
import { truncateUtf8 } from "../../shared/text.ts";
import { boundWorkflowOwnership } from "../../shared/workflow-metadata.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
export const MAX_ADMISSION_WAITERS = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;
const WORKFLOW_OUTPUT_MAX_BYTES = 64 * 1_024;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error) return squashed.message || squashed.name;
  const message = String(squashed);
  return message || "Subagent spawn interrupted or failed";
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(
      0,
      snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function boundedJsonCopy(value: unknown, maxBytes: number, label: string) {
  if (value === undefined) return { value: undefined };
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return { error: `${label} was not JSON serializable.` };
    }
    if (Buffer.byteLength(json, "utf8") > maxBytes) {
      return {
        error: `${label} exceeded the ${maxBytes} byte workflow collection limit.`,
      };
    }
    return { value: JSON.parse(json) as unknown };
  } catch {
    return { error: `${label} was not JSON serializable.` };
  }
}

function collectedSettlement(entry: Entry): CollectedWorkflowSettlement {
  const source = entry.snapshot;
  const structuredCopy = boundedJsonCopy(
    source.structured,
    STRUCTURED_OUTPUT_MAX_BYTES,
    "Structured result",
  );
  const schemaCopy = boundedJsonCopy(
    source.schema,
    JSON_SCHEMA_MAX_BYTES,
    "Structured output schema",
  );
  const transcript = source.transcript.map((item): TranscriptItem => {
    if (item.kind === "user") return { ...item };
    if (item.kind === "toolResult") return { ...item };
    return {
      ...item,
      parts: item.parts.map((part) => ({ ...part })),
    };
  });
  const snapshot = deepFreeze({
    ...source,
    identity: { ...source.identity },
    schema: schemaCopy.value,
    structured: structuredCopy.value,
    meta: { ...source.meta },
    usage: { ...source.usage },
    transcript,
    liveAssistant: source.liveAssistant
      ? { ...source.liveAssistant }
      : undefined,
    liveTools: source.liveTools.map((tool) => ({ ...tool })),
    queued: source.queued.map((queued) => ({ ...queued })),
    finalText: truncateUtf8(source.finalText, WORKFLOW_OUTPUT_MAX_BYTES),
  } satisfies SubagentSnapshot);
  const sourceOutcome = entry.lastOutcome ?? {
    _tag: "Failed" as const,
    errorText: source.errorText ?? "Agent settlement was unavailable",
    partialText: snapshot.finalText || undefined,
  };
  let outcome: RunOutcome;
  if (sourceOutcome._tag === "Completed") {
    outcome = {
      _tag: "Completed",
      finalText: snapshot.finalText,
      ...(structuredCopy.value === undefined
        ? {}
        : { structured: structuredCopy.value }),
    };
  } else if (sourceOutcome._tag === "Interrupted") {
    outcome = {
      _tag: "Interrupted",
      ...(snapshot.finalText ? { partialText: snapshot.finalText } : {}),
      ...(sourceOutcome.errorText
        ? { errorText: bounded(sourceOutcome.errorText) }
        : {}),
    };
  } else {
    outcome = {
      _tag: "Failed",
      errorText: bounded(sourceOutcome.errorText),
      ...(snapshot.finalText ? { partialText: snapshot.finalText } : {}),
      ...(sourceOutcome.schemaError
        ? { schemaError: bounded(sourceOutcome.schemaError) }
        : {}),
    };
  }
  const collectionErrors = [structuredCopy.error, schemaCopy.error].filter(
    (error): error is string => error !== undefined,
  );
  return deepFreeze({
    snapshot,
    outcome,
    ...(collectionErrors.length > 0
      ? { collectionError: collectionErrors.join(" ") }
      : {}),
  });
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  identity: SubagentIdentity;
  origin: SubagentOrigin;
  autoDeliver: boolean;
  workflowRunId?: string;
  workflowAgentIndex?: number;
  workflowPhase?: string;
  workflowLabel?: string;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  role?: string;
  schema?: unknown;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  structured?: unknown;
  schemaError?: string;
  meta: SubagentMeta;
  usage: {
    tokens?: number;
    contextWindow?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  session: SubagentSession;
  scope: Scope.Closeable;
  roleLease?: RoleLeaseHandle;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  toolStartedAt: Map<string, number>;
  lastOutcome?: RunOutcome;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
  /** Minted before an idle backend send and promoted at its first boundary. */
  pendingTurnId?: TurnId;
  /** UserMessage arrived before RunStarted and already promoted pendingTurnId. */
  turnPromotedBeforeRunStart?: boolean;
  /** Native RunStarted boundaries observed for this manager entry. */
  runCount: number;
  /** Start time of the current native run, for per-turn settlement duration. */
  runStartedAt?: number;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active
   * subagent_wait/cancel is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface ResumeRoleResult {
  readonly snapshot: SubagentSnapshot;
  /** True when native history was reopened into a fresh current-session id. */
  readonly reopened: boolean;
}

export interface WorkflowAgentHooks {
  readonly signal?: AbortSignal;
  readonly onAdmissionWait?: () => void;
  readonly onSpawned?: (snapshot: SubagentSnapshot) => void;
}

/** Immutable bounded copy captured while the manager still pins the entry. */
export interface CollectedWorkflowSettlement {
  readonly snapshot: SubagentSnapshot;
  readonly outcome: RunOutcome;
  readonly collectionError?: string;
}

export interface SubagentManagerShape {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /**
   * Workflow-only fused reservation/spawn/collect. Its pruning pin is created
   * with the durable reservation and released only after the frozen result
   * copy exists. Cancellation is handled as manager work, never by
   * interrupting this collection effect.
   */
  runWorkflowAgent(
    backend: BackendName,
    task: SpawnTask,
    hooks?: WorkflowAgentHooks,
  ): Effect.Effect<
    CollectedWorkflowSettlement,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /** Route a role already tracked in this manager, otherwise reopen it. */
  resumeRole(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    ResumeRoleResult,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError | SendError
  >;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<void, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  const observabilitySink = yield* ObservabilitySinkService;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  const waitInterest = new Map<string, number>();
  const collectionPins = new Set<string>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let modelCounter = 0;
  let btwCounter = 0;
  let reserved = 0;
  let workflowAdmissionReservations = 0;
  let disposed = false;

  interface AdmissionToken {
    active: boolean;
  }
  interface AdmissionWaiter {
    readonly token: AdmissionToken;
    readonly resolve: (token: AdmissionToken) => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
    onAbort?: () => void;
  }
  const admissionWaiters: AdmissionWaiter[] = [];
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  type PendingEvent = Parameters<typeof observabilitySink.emit>[0];
  const observe = (
    build: () => PendingEvent | ReadonlyArray<PendingEvent> | undefined,
  ) => {
    if (observabilitySink === NOOP_OBSERVABILITY_SINK) return;
    try {
      const built = build();
      if (!built) return;
      const events = Array.isArray(built) ? built : [built];
      for (const event of events) safeEmit(observabilitySink, event);
    } catch {
      // Normalization and sink bugs are both outside manager lifecycle state.
    }
  };

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () =>
    [...entries.values()].filter(
      (e) => e.snapshot.status === "running" || e.restarting === true,
    ).length;

  const hasAdmissionCapacity = () =>
    runningCount() + reserved + workflowAdmissionReservations < MAX_RUNNING;

  const detachAdmissionWaiter = (waiter: AdmissionWaiter) => {
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  };

  const drainAdmissionWaiters = () => {
    while (!disposed && admissionWaiters.length > 0 && hasAdmissionCapacity()) {
      const waiter = admissionWaiters.shift()!;
      detachAdmissionWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("Agent was aborted before admission."));
        continue;
      }
      workflowAdmissionReservations++;
      waiter.resolve(waiter.token);
    }
  };

  const releaseAdmission = (token: AdmissionToken | undefined) => {
    if (!token?.active) return;
    token.active = false;
    workflowAdmissionReservations = Math.max(
      0,
      workflowAdmissionReservations - 1,
    );
    drainAdmissionWaiters();
    notify();
  };

  const acquireWorkflowAdmission = (hooks: WorkflowAgentHooks) =>
    Effect.tryPromise({
      try: () => {
        if (disposed) {
          return Promise.reject(
            new Error("Subagent manager is shutting down."),
          );
        }
        if (hooks.signal?.aborted) {
          return Promise.reject(
            new Error("Agent was aborted before admission."),
          );
        }
        const token: AdmissionToken = { active: true };
        if (admissionWaiters.length === 0 && hasAdmissionCapacity()) {
          workflowAdmissionReservations++;
          return Promise.resolve(token);
        }
        if (admissionWaiters.length >= MAX_ADMISSION_WAITERS) {
          return Promise.reject(
            new Error(
              `Workflow admission queue is full (max ${MAX_ADMISSION_WAITERS} waiting calls).`,
            ),
          );
        }
        try {
          hooks.onAdmissionWait?.();
        } catch {
          // Progress hooks never affect admission.
        }
        return new Promise<AdmissionToken>((resolve, reject) => {
          const waiter: AdmissionWaiter = {
            token,
            resolve,
            reject,
            signal: hooks.signal,
          };
          if (hooks.signal) {
            waiter.onAbort = () => {
              const index = admissionWaiters.indexOf(waiter);
              if (index >= 0) admissionWaiters.splice(index, 1);
              detachAdmissionWaiter(waiter);
              token.active = false;
              reject(new Error("Agent was aborted before admission."));
            };
            hooks.signal.addEventListener("abort", waiter.onAbort, {
              once: true,
            });
          }
          admissionWaiters.push(waiter);
        });
      },
      catch: (error) =>
        error instanceof Error && /queue is full/.test(error.message)
          ? new ConcurrencyLimitError({ message: error.message })
          : new SpawnError({
              message: error instanceof Error ? error.message : String(error),
            }),
    });

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    Scope.close(entry.scope, Exit.void).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.roleLease?.release();
          entry.roleLease = undefined;
        }),
      ),
      Effect.ignore,
    );

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" &&
          !waitInterest.has(e.snapshot.id) &&
          !collectionPins.has(e.snapshot.identity.agentId),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.structured = outcome.structured;
        s.schemaError = undefined;
        s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        s.structured = undefined;
        s.schemaError = outcome.schemaError
          ? bounded(outcome.schemaError)
          : undefined;
        // Never let a failed run report the previous run's successful output.
        s.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = bounded(outcome.errorText ?? "Run was aborted");
        s.structured = undefined;
        s.schemaError = undefined;
        s.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
    }
    s.liveAssistant = undefined;
    entry.lastOutcome = outcome;
    entry.liveToolMap.clear();
    entry.toolStartedAt.clear();
    s.liveTools = [];
    s.queued = [];
    const consumed =
      (waitInterest.get(s.id) ?? 0) > 0 ||
      collectionPins.has(s.identity.agentId);
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    observe(() =>
      agentSettledEvent(
        s,
        outcome,
        entry.runCount,
        entry.runStartedAt ?? s.createdAt,
      ),
    );
    entry.turnPromotedBeforeRunStart = false;
    drainAdmissionWaiters();
    pruneSettled();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        if (entry.runCount > 0) {
          if (entry.turnPromotedBeforeRunStart) {
            entry.turnPromotedBeforeRunStart = false;
          } else {
            s.identity = Object.freeze({
              ...s.identity,
              turnId: entry.pendingTurnId ?? mintTurnId(),
            });
            entry.pendingTurnId = undefined;
          }
        }
        entry.runCount++;
        entry.runStartedAt = Date.now();
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        // Structured state is per run. Unlike finalText's compatibility
        // preview, it must never expose the previous turn as the current one.
        s.structured = undefined;
        s.schemaError = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        // Codex and the stub announce a follow-up prompt before RunStarted.
        // Promote the pending identity first so the prompt is never bucketed
        // under the previous turn; RunStarted then preserves this identity.
        if (entry.runCount > 0 && entry.pendingTurnId) {
          s.identity = Object.freeze({
            ...s.identity,
            turnId: entry.pendingTurnId,
          });
          entry.pendingTurnId = undefined;
          entry.turnPromotedBeforeRunStart = true;
        }
        appendTranscript(s, {
          kind: "user",
          text: boundedTranscriptText(event.text),
          timestamp: Date.now(),
        });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? {
                ...live,
                text: (live.text + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              }
            : {
                ...live,
                thinking: (live.thinking + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              };
        break;
      }
      case "AssistantMessage":
        appendTranscript(s, {
          kind: "assistant",
          timestamp: Date.now(),
          parts: event.parts.map((part) =>
            part.type === "toolCall"
              ? {
                  ...part,
                  argsPreview: part.argsPreview
                    ? boundedTranscriptText(part.argsPreview)
                    : undefined,
                }
              : { ...part, text: boundedTranscriptText(part.text) },
          ),
        });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.toolStartedAt.set(event.toolId, Date.now());
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview
            ? boundedTranscriptText(event.argsPreview)
            : undefined,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd": {
        const finishedAt = Date.now();
        const startedAt = entry.toolStartedAt.get(event.toolId);
        entry.toolStartedAt.delete(event.toolId);
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        appendTranscript(s, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
          timestamp: finishedAt,
          ...(startedAt === undefined
            ? {}
            : {
                startedAt,
                finishedAt,
                durationMs: Math.max(0, finishedAt - startedAt),
              }),
        });
        break;
      }
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
          inputTokens: event.inputTokens ?? s.usage.inputTokens,
          outputTokens: event.outputTokens ?? s.usage.outputTokens,
          cacheReadTokens: event.cacheReadTokens ?? s.usage.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens ?? s.usage.cacheWriteTokens,
          costUsd: event.costUsd ?? s.usage.costUsd,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  const spawnInternal = (
    backendName: BackendName,
    task: SpawnTask,
    options: {
      admission?: AdmissionToken;
      collect?: boolean;
      signal?: AbortSignal;
      onSpawned?: (snapshot: SubagentSnapshot) => void;
    } = {},
  ) =>
    Effect.gen(function* () {
      let reservedAt = 0;
      let reservedTask!: SpawnTask & { readonly identity: SubagentIdentity };
      let pinnedAgentId: string | undefined;
      // Reserve and mint synchronously before availability probing or backend
      // spawn, so parallel calls cannot race either the cap or durable IDs.
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          const rejectBeforeReservation = <E>(error: E) => {
            task.roleLease?.release();
            return error;
          };
          if (disposed) {
            return rejectBeforeReservation(
              new SpawnError({
                message: "Subagent manager is shutting down.",
              }),
            );
          }
          if (options.signal?.aborted) {
            return rejectBeforeReservation(
              new SpawnError({ message: "Agent was aborted before spawn." }),
            );
          }

          const origin = task.origin ?? "model";
          let normalizedTask: SpawnTask = task;
          if (origin === "workflow") {
            if (task.role || task.roleLease || task.resume) {
              return rejectBeforeReservation(
                new SpawnError({
                  message:
                    "Workflow-origin subagents cannot use roles, role leases, or resume locators.",
                }),
              );
            }
            let ownership;
            try {
              ownership = boundWorkflowOwnership({
                workflowRunId: task.workflowRunId,
                workflowAgentIndex: task.workflowAgentIndex,
                workflowPhase: task.workflowPhase,
                workflowLabel: task.workflowLabel,
              });
            } catch (error) {
              return rejectBeforeReservation(
                new SpawnError({
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              );
            }
            normalizedTask = {
              ...task,
              ...ownership,
              origin: "workflow",
              autoDeliver: false,
            };
          } else if (
            task.workflowRunId !== undefined ||
            task.workflowAgentIndex !== undefined ||
            task.workflowPhase !== undefined ||
            task.workflowLabel !== undefined
          ) {
            return rejectBeforeReservation(
              new SpawnError({
                message:
                  "Workflow ownership metadata is allowed only for workflow-origin subagents.",
              }),
            );
          }

          if (options.admission) {
            if (!options.admission.active) {
              return rejectBeforeReservation(
                new SpawnError({ message: "Workflow admission expired." }),
              );
            }
            options.admission.active = false;
            workflowAdmissionReservations = Math.max(
              0,
              workflowAdmissionReservations - 1,
            );
          } else if (
            runningCount() + reserved + workflowAdmissionReservations >=
            MAX_RUNNING
          ) {
            return rejectBeforeReservation(
              new ConcurrencyLimitError({
                message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
              }),
            );
          }

          const fallbackParent = mintEphemeralParentIdentity();
          const identity: SubagentIdentity = Object.freeze({
            runId:
              origin === "workflow"
                ? normalizedTask.workflowRunId!
                : mintStandaloneRunId(),
            agentId: mintAgentId(),
            turnId: mintTurnId(),
            origin,
            parentRunId:
              normalizedTask.parent.rootRunId ?? fallbackParent.rootRunId,
            traceId: normalizedTask.parent.traceId ?? fallbackParent.traceId,
          });
          reservedTask = Object.freeze({ ...normalizedTask, identity });
          reservedAt = Date.now();
          reserved++;
          if (options.collect) {
            pinnedAgentId = identity.agentId;
            collectionPins.add(identity.agentId);
          }
          observe(() =>
            agentCreatedEvent(backendName, reservedTask, reservedAt),
          );
          return Effect.void;
        },
      );

      const doSpawn = Effect.gen(function* () {
        if (options.signal?.aborted) {
          return yield* new SpawnError({
            message: "Agent was aborted before backend spawn.",
          });
        }
        const backend: SubagentBackend | undefined = registry.get(backendName);
        if (!backend) {
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        }
        const available = yield* backend.available;
        if (!available) {
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
          });
        }

        const scope = yield* Scope.make();
        const session = yield* Scope.provide(
          backend.spawn(reservedTask),
          scope,
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        if (disposed || options.signal?.aborted) {
          yield* Scope.close(scope, Exit.void);
          return yield* new SpawnError({
            message: disposed
              ? "Subagent manager shut down while spawning."
              : "Agent was aborted while spawning.",
          });
        }

        const origin = reservedTask.identity.origin;
        const autoDeliver =
          origin === "workflow"
            ? false
            : (reservedTask.autoDeliver ?? origin === "model");
        const id =
          origin === "btw" ? `btw-${++btwCounter}` : `sa-${++modelCounter}`;
        const meta = yield* session.meta;
        const entry: Entry = {
          snapshot: {
            id,
            identity: reservedTask.identity,
            origin,
            autoDeliver,
            workflowRunId: reservedTask.workflowRunId,
            workflowAgentIndex: reservedTask.workflowAgentIndex,
            workflowPhase: reservedTask.workflowPhase,
            workflowLabel: reservedTask.workflowLabel,
            backend: backendName,
            title: reservedTask.title,
            prompt: reservedTask.prompt,
            cwd: reservedTask.cwd,
            role: reservedTask.role,
            schema: reservedTask.schema,
            status: "running",
            createdAt: Date.now(),
            meta,
            usage: { contextWindow: meta.contextWindow },
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: "",
            turns: 0,
          },
          session,
          scope,
          roleLease: reservedTask.roleLease,
          liveToolMap: new Map(),
          toolStartedAt: new Map(),
          runCount: 0,
        };
        entries.set(id, entry);
        try {
          options.onSpawned?.(entry.snapshot);
        } catch {
          // Workflow progress hooks are outside lifecycle ownership.
        }

        // Pump: fold the event stream into the snapshot. Tied to the entry
        // scope, so closing the scope stops it. If the stream ends while the
        // subagent still looks running, the backend died out from under us.
        const pump = Stream.runForEach(session.events, (event) =>
          Effect.sync(() => {
            foldEvent(entry, event);
            observe(() => subagentEvent(entry.snapshot, event, entry.runCount));
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entry.snapshot.status === "running") {
                settle(entry, {
                  _tag: "Failed",
                  errorText: "Backend event stream ended unexpectedly",
                });
              }
            }),
          ),
        );
        entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);

        notify(id);
        return entry.snapshot as SubagentSnapshot;
      });

      return yield* doSpawn.pipe(
        Effect.onError((cause) =>
          Effect.sync(() => {
            observe(() =>
              spawnFailureEvents({
                backend: backendName,
                task: reservedTask,
                createdAt: reservedAt,
                message: causeMessage(cause),
              }),
            );
            reservedTask.roleLease?.release();
            if (pinnedAgentId) collectionPins.delete(pinnedAgentId);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            drainAdmissionWaiters();
            notify();
          }),
        ),
      );
    });

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    spawnInternal(backendName, task);

  const resumeRole = (backendName: BackendName, task: SpawnTask) =>
    Effect.suspend(
      (): Effect.Effect<
        ResumeRoleResult,
        SpawnError | ConcurrencyLimitError | BackendUnavailableError | SendError
      > => {
        if (!task.role) {
          task.roleLease?.release();
          return new SpawnError({
            message: "Resuming a subagent requires a role.",
          });
        }
        const existing = [...entries.values()].find(
          (entry) => entry.snapshot.role === task.role,
        );
        if (existing) {
          task.roleLease?.release();
          if (!isDeepStrictEqual(task.schema, existing.snapshot.schema)) {
            return new SendError({
              message: `Role "${task.role}" is active and its structured-output schema cannot be changed until it is reopened.`,
            });
          }
          return send(existing.snapshot.id, task.prompt).pipe(
            Effect.map((): ResumeRoleResult => ({
              snapshot: existing.snapshot,
              reopened: false,
            })),
          );
        }
        return spawn(backendName, task).pipe(
          Effect.map((snapshot): ResumeRoleResult => ({
            snapshot,
            reopened: true,
          })),
        );
      },
    );

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const entry = entries.get(id);
            return (
              entry?.snapshot.status === "running" || entry?.restarting === true
            );
          });
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  /** Interrupt one running entry, force-closing its scope after 5s. */
  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (entry.snapshot.status !== "running") return;
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        yield* Effect.sync(() => {
          settle(entry, {
            _tag: "Interrupted",
            errorText: "Abort deadline exceeded; session was force-disposed",
          });
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled.
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
      } else if (entry.snapshot.status === "running") {
        // A backend may acknowledge interruption before its terminal event is
        // folded. Settle deterministically; a later duplicate is ignored.
        yield* Effect.sync(() =>
          settle(entry, {
            _tag: "Interrupted",
            errorText: "Run was aborted",
          }),
        );
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry => entry?.snapshot.status === "running",
        );
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, {
          concurrency: "unbounded",
        });
        while (running.some((entry) => entry.snapshot.status === "running")) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const runWorkflowAgent = (
    backendName: BackendName,
    task: SpawnTask,
    hooks: WorkflowAgentHooks = {},
  ) =>
    Effect.gen(function* () {
      const admission = yield* acquireWorkflowAdmission(hooks);
      const started = yield* spawnInternal(
        backendName,
        { ...task, origin: "workflow", autoDeliver: false },
        {
          admission,
          collect: true,
          signal: hooks.signal,
          onSpawned: hooks.onSpawned,
        },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseAdmission(admission);
          }),
        ),
      );

      const entry = entries.get(started.id);
      if (!entry) {
        collectionPins.delete(started.identity.agentId);
        return yield* new SpawnError({
          message: "Workflow agent entry disappeared before collection.",
        });
      }

      let cancellationRequested = false;
      const requestCancellation = () => {
        if (cancellationRequested) return;
        cancellationRequested = true;
        runDetached(cancel([started.id]).pipe(Effect.ignore));
      };
      hooks.signal?.addEventListener("abort", requestCancellation, {
        once: true,
      });
      if (hooks.signal?.aborted) requestCancellation();

      const collect = Effect.gen(function* () {
        while (
          entry.snapshot.status === "running" ||
          entry.restarting === true
        ) {
          yield* nextChange;
        }
        return collectedSettlement(entry);
      });
      return yield* collect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            hooks.signal?.removeEventListener("abort", requestCancellation);
            collectionPins.delete(entry.snapshot.identity.agentId);
            pruneSettled();
            notify(entry.snapshot.id);
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (entry.snapshot.origin === "workflow") {
        return new SendError({
          message:
            "Workflow-origin subagents cannot be steered or restarted outside their script agent() call.",
        });
      }
      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (entry.snapshot.status !== "running") {
        if (
          runningCount() + reserved + workflowAdmissionReservations >=
          MAX_RUNNING
        ) {
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        }
        // Occupy the slot and clear per-turn structured state synchronously.
        // Some backends resolve send() only after the new run has already
        // settled; a post-send tap would erase that fresh result.
        entry.restarting = true;
        entry.pendingTurnId = mintTurnId();
        entry.snapshot.structured = undefined;
        entry.snapshot.schemaError = undefined;
        notify(entry.snapshot.id);
        return entry.session.send(text).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              entry.restarting = false;
              entry.pendingTurnId = undefined;
              notify(entry.snapshot.id);
            }),
          ),
        );
      }
      return entry.session.send(text);
    });

  const disposeAll = Effect.gen(function* () {
    if (disposed && entries.size === 0) return;
    disposed = true;
    const queuedAdmissions = admissionWaiters.splice(0);
    for (const waiter of queuedAdmissions) {
      detachAdmissionWaiter(waiter);
      waiter.token.active = false;
      waiter.reject(new Error("Subagent manager is shutting down."));
    }
    workflowAdmissionReservations = 0;
    const all = [...entries.values()];
    yield* Effect.forEach(all, abortEntry, { concurrency: "unbounded" });
    // Give fused workflow collectors a bounded window to copy their settled
    // entries before runtime disposal can interrupt consumer fibers.
    yield* Effect.gen(function* () {
      while (collectionPins.size > 0) yield* nextChange;
    }).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    entries.clear();
    // Pruning cleanups are detached; bound them like everything else so a
    // stuck backend finalizer cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => {
      collectionPins.clear();
      notify();
    });
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    runWorkflowAgent,
    resumeRole,
    waitFor,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerWithSink: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry | ObservabilitySinkService
> = Layer.effect(SubagentManager, makeManager);

/** Default C0 manager: shared sink seam present, production behavior is no-op. */
export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = SubagentManagerWithSink.pipe(Layer.provide(NoopObservabilitySinkLayer));
