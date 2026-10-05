/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Cause } from "effect";
import { Effect, Exit, Queue, Result, Scope, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  createProtectedPathToolGuard,
  protectedPathPolicy,
  shutdownAndDisposeChildSession,
} from "../../../shared/child-session.ts";
import {
  makeStructuredOutputTool,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
} from "../../../shared/structured-output.ts";
import { createToolCallTimeoutGuard } from "../../../shared/tool-call-timeout.ts";
import { MISSING_STRUCTURED_OUTPUT_ERROR } from "../structured-output.ts";
import { handoffDecision } from "../handoff/policy.ts";
import {
  buildContinuationPrompt,
  formatHandoffDocument,
  handoffSummaryInstructions,
} from "../handoff/prompt.ts";
import {
  createHandoffRecorder,
  handoffDocumentFromAgentText,
} from "../handoff/controller.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const STRUCTURED_UNSET = Symbol("structured-output-unset");

/** Per-native-run structured capture used by the Pi event lifecycle. */
export function createPiStructuredCapture(required: boolean) {
  let value: unknown | typeof STRUCTURED_UNSET = STRUCTURED_UNSET;
  return {
    reset() {
      value = STRUCTURED_UNSET;
    },
    capture(next: unknown) {
      value = next;
    },
    complete(finalText: string): RunOutcome {
      if (!required) return { _tag: "Completed", finalText };
      if (value === STRUCTURED_UNSET) {
        return {
          _tag: "Failed",
          errorText: MISSING_STRUCTURED_OUTPUT_ERROR,
          partialText: finalText || undefined,
          schemaError: MISSING_STRUCTURED_OUTPUT_ERROR,
        };
      }
      return { _tag: "Completed", finalText, structured: value };
    },
  };
}

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

/**
 * Resolve the generic model hint against the parent registry (v1 semantics):
 * "provider/model-id" is exact; a bare id prefers the inherited provider,
 * then must be unambiguous across providers. No hint inherits the parent
 * model; with nothing to inherit, the SDK default applies.
 */
function resolvePiModel(
  registry: ModelRegistry,
  hint: string | undefined,
  inherited: { provider: string; id: string } | undefined,
): Model<any> | undefined {
  if (!hint) {
    if (!inherited) return undefined;
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((m) => m.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

// --- Child session helpers ---------------------------------------------------

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

// --- Event translation ----------------------------------------------------------

function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

function lastAssistantMessage(
  session: AgentSession,
): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
function finalOutput(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview: safeJson(part.arguments),
      });
    }
  }
  return parts;
}

function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

// --- The session ------------------------------------------------------------------

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

const makePiSessionSegment = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    if (task.resume && !task.resume.sessionFilePath) {
      return yield* new SpawnError({
        message: "Pi resume requires a session file path.",
      });
    }
    const registry = task.parent.modelRegistry;
    if (!registry) {
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    }

    const model = yield* Effect.try({
      try: () =>
        resolvePiModel(
          registry,
          task.model,
          task.resume ? undefined : task.parent.inheritedModel,
        ),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    // pi's thinking levels ARE the shared reasoning-effort scale.
    const thinkingLevel = (task.reasoningEffort ??
      (task.resume ? undefined : task.parent.inheritedThinkingLevel)) as
      ThinkingLevel | undefined;

    const structuredCapture = createPiStructuredCapture(
      task.schema !== undefined,
    );
    const customTools =
      task.schema === undefined
        ? undefined
        : [
            makeStructuredOutputTool(task.schema, (value) => {
              structuredCapture.capture(value);
            }),
          ];

    const session = yield* Effect.tryPromise({
      try: async () => {
        const { loader, settingsManager } = await createChildResources({
          cwd: task.cwd,
          projectTrusted: task.parent.projectTrusted,
          ...(task.schema === undefined
            ? {}
            : {
                appendSystemPrompt: [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION],
              }),
        });
        const { session } = await createAgentSession({
          cwd: task.cwd,
          sessionManager: task.resume?.sessionFilePath
            ? SessionManager.open(
                task.resume.sessionFilePath,
                undefined,
                task.cwd,
              )
            : SessionManager.create(task.cwd),
          settingsManager,
          resourceLoader: loader,
          model,
          thinkingLevel,
          ...(customTools ? { customTools } : {}),
          ...childToolPolicy(),
        });
        // Start child extension session hooks/resources in headless mode.
        // A rejection here would otherwise leak the freshly created session:
        // the scope finalizer that owns cleanup is only registered later.
        try {
          await bindChildSessionExtensions(session);
        } catch (error) {
          await shutdownAndDisposeChildSession(session);
          throw error;
        }
        return session;
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const state = {
      closed: false,
      /** prompt() rejection for the active run; folded into RunSettled. */
      runError: undefined as string | undefined,
      /** One terminal event per run: lifecycle, prompt-rejection, and abort
       * fallbacks can all race to settle; the first wins. */
      settled: false,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const toolTimeout = createToolCallTimeoutGuard();
    const protectedPaths = createProtectedPathToolGuard(protectedPathPolicy());
    protectedPaths.apply(session);
    toolTimeout.apply(session);

    const activeModel = (): Model<any> | undefined => {
      const sessionModel = session.model;
      const last = lastAssistantMessage(session);
      if (!last) return sessionModel;
      if (
        sessionModel &&
        (last.provider !== sessionModel.provider ||
          last.model !== sessionModel.id)
      ) {
        // The session changed models after this assistant response.
        return sessionModel;
      }
      return (
        registry.find(last.provider, last.responseModel ?? last.model) ??
        sessionModel
      );
    };

    const currentMeta = (): SubagentMeta => {
      const m = activeModel();
      return {
        backend: "pi",
        modelLabel: m ? `${m.provider}/${m.id}` : undefined,
        contextWindow: m?.contextWindow,
        sessionFilePath: session.sessionFile,
        nativeSessionId: session.sessionId,
      };
    };

    const emitUsage = () => {
      const contextUsage = session.getContextUsage();
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let costUsd = 0;
      for (const message of session.messages) {
        if (messageRole(message) !== "assistant") continue;
        const usage = (message as AssistantMessage).usage;
        inputTokens += usage?.input ?? 0;
        outputTokens += usage?.output ?? 0;
        cacheReadTokens += usage?.cacheRead ?? 0;
        cacheWriteTokens += usage?.cacheWrite ?? 0;
        costUsd += usage?.cost?.total ?? 0;
      }
      emit({
        _tag: "UsageChanged",
        tokens: contextUsage?.tokens ?? undefined,
        contextWindow:
          activeModel()?.contextWindow ?? contextUsage?.contextWindow,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
      });
    };

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      const last = lastAssistantMessage(session);
      const partialText = finalOutput(session) || undefined;
      if (last?.stopReason === "aborted") {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Interrupted", partialText },
        });
        return;
      }
      const errorText =
        state.runError ??
        (last?.stopReason === "error"
          ? (last.errorMessage ?? "Run failed")
          : undefined);
      if (errorText !== undefined) {
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Failed",
            errorText: boundedError(errorText),
            partialText,
          },
        });
        return;
      }
      emit({
        _tag: "RunSettled",
        outcome: structuredCapture.complete(finalOutput(session)),
      });
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (state.closed) return;
      switch (event.type) {
        case "agent_start":
          // Extensions may register tools between runs; guard new ones too.
          protectedPaths.apply(session);
          toolTimeout.apply(session);
          // Pi can begin work through retry/continue/queued-follow-up paths
          // that do not call startRun(). Every native agent run therefore
          // resets the structured capture at this lifecycle boundary.
          structuredCapture.reset();
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: streamEvent.delta,
            });
          } else if (streamEvent.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: streamEvent.delta,
            });
          }
          break;
        }
        case "message_end": {
          const role = messageRole(event.message);
          if (role === "user") {
            const text = userText(event.message as Message);
            if (text.trim()) emit({ _tag: "UserMessage", text });
          } else if (role === "assistant") {
            emit({
              _tag: "AssistantMessage",
              parts: assistantParts(event.message as AssistantMessage),
            });
            emitUsage();
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          // toolResult messages are covered by tool_execution_end.
          break;
        }
        case "tool_execution_start":
          emit({
            _tag: "ToolStart",
            toolId: event.toolCallId,
            name: event.toolName,
            argsPreview: safeJson(event.args),
          });
          break;
        case "tool_execution_update":
          emit({
            _tag: "ToolUpdate",
            toolId: event.toolCallId,
            outputPreview: toolPreview(event.partialResult),
          });
          break;
        case "tool_execution_end":
          emit({
            _tag: "ToolEnd",
            toolId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            outputPreview: toolPreview(event.result),
          });
          break;
        case "queue_update":
          emit({
            _tag: "QueueChanged",
            queued: [
              ...event.steering.map((text) => ({
                text,
                kind: "steer" as const,
              })),
              ...event.followUp.map((text) => ({
                text,
                kind: "follow-up" as const,
              })),
            ],
          });
          break;
        case "agent_settled":
          settle();
          break;
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        unsubscribe();
        try {
          session.clearQueue();
        } catch {
          // Continue with abort/dispose.
        }
        await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS);
        await shutdownAndDisposeChildSession(session);
        Queue.endUnsafe(events);
      }),
    );

    /** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
    const startRun = (text: string) => {
      state.runError = undefined;
      state.settled = false;
      structuredCapture.reset();
      emit({ _tag: "RunStarted" });
      void session.prompt(text).catch((error) => {
        state.runError = boundedError(error);
        // Preflight failures may never start the agent lifecycle, so no
        // agent_settled will arrive for them.
        if (!session.isStreaming) settle();
      });
    };

    // Session naming is best-effort.
    yield* Effect.try(() =>
      session.sessionManager.appendSessionInfo(
        `${task.origin === "btw" ? "btw" : "subagent"}: ${task.title}`,
      ),
    ).pipe(Effect.ignore);

    emit({ _tag: "MetaChanged", meta: currentMeta() });
    startRun(task.prompt);

    return {
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (session.isStreaming) {
            // Steer the active run via the SDK's queue; queue_update events
            // render it, message_end(user) lands it in the transcript. A
            // rejected steer is a real send failure, not a diagnostic.
            return Effect.tryPromise({
              try: () => session.steer(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        try {
          session.clearQueue();
        } catch {
          // Abort regardless.
        }
        await session.abort().catch(() => undefined);
        // Only resolve once streaming has actually stopped: reporting the
        // interrupt as complete while the run keeps working would let the
        // manager settle a run that is still mutating the workspace. The
        // manager bounds this effect at 5s and force-disposes on timeout.
        while (!state.closed && session.isStreaming) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // No streaming run means no agent_settled will arrive; emit the
        // terminal event (once) so the run cannot look running forever.
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        }
      }),
    } satisfies SubagentSession;
  });

export type PiSessionSegmentFactory = (
  task: SpawnTask,
) => Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;

/**
 * Wrap fresh Pi session segments behind one logical backend session.
 * The injectable segment factory keeps rollover lifecycle behavior hermetic in
 * tests; production always supplies makePiSessionSegment.
 */
export const makePiHandoffSession = (
  task: SpawnTask,
  createSegment: PiSessionSegmentFactory,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const outerScope = yield* Effect.scope;
    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const recorder = createHandoffRecorder(task.prompt);
    const segments = new Set<Scope.Scope>();
    let currentSession: SubagentSession | undefined;
    let currentScope: Scope.Scope | undefined;
    let currentMeta: SubagentMeta = { backend: "pi" };
    let active = false;
    let latestUsage: { tokens?: number; contextWindow?: number } = {};
    let handoffCount = 0;
    let closed = false;
    let suppressSegmentEvents = false;
    let handoffWaiter: ((outcome: RunOutcome) => void) | undefined;

    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);

    const recordEvent = (event: SubagentEvent) => {
      switch (event._tag) {
        case "RunStarted":
          active = true;
          break;
        case "RunSettled":
          active = false;
          if (event.outcome._tag === "Completed") {
            recorder.record({ kind: "final", text: event.outcome.finalText });
          } else {
            recorder.record({
              kind: "error",
              text:
                event.outcome._tag === "Failed"
                  ? event.outcome.errorText
                  : event.outcome.errorText,
            });
          }
          break;
        case "UserMessage":
          recorder.record({ kind: "user", text: event.text });
          break;
        case "AssistantMessage":
          recorder.record({
            kind: "assistant",
            text: event.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          });
          break;
        case "ToolEnd":
          recorder.record({
            kind: "tool",
            name: event.name,
            isError: event.isError,
            text: event.outputPreview,
          });
          break;
        case "UsageChanged":
          latestUsage = {
            tokens: event.tokens,
            contextWindow: event.contextWindow,
          };
          recorder.record({ kind: "usage", ...latestUsage });
          break;
        case "MetaChanged":
          currentMeta = { ...currentMeta, ...event.meta };
          recorder.record({ kind: "meta" });
          break;
        case "BackendError":
          recorder.record({ kind: "error", text: event.message });
          break;
        case "QueueChanged":
        case "AssistantDelta":
        case "ToolStart":
        case "ToolUpdate":
        case "Handoff":
          break;
      }
    };

    const closeSegment = (scope: Scope.Scope | undefined) =>
      scope ? Scope.close(scope, Exit.void).pipe(Effect.ignore) : Effect.void;

    const openSegment = (prompt: string) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const segment = yield* Scope.provide(
          createSegment({ ...task, prompt, resume: undefined }),
          scope,
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        segments.add(scope);
        currentScope = scope;
        currentSession = segment;
        currentMeta = yield* segment.meta;
        const pump = Stream.runForEach(segment.events, (event) =>
          Effect.sync(() => {
            if (suppressSegmentEvents) {
              if (event._tag === "RunStarted") {
                active = true;
              } else if (event._tag === "RunSettled") {
                active = false;
                handoffWaiter?.(event.outcome);
                handoffWaiter = undefined;
              } else if (event._tag === "UsageChanged") {
                latestUsage = {
                  tokens: event.tokens,
                  contextWindow: event.contextWindow,
                };
              } else if (event._tag === "MetaChanged") {
                currentMeta = { ...currentMeta, ...event.meta };
              }
              return;
            }
            recordEvent(event);
            emit(event);
          }),
        );
        yield* Effect.forkIn(pump, outerScope);
        return segment;
      });

    const continueInFreshSegment = (
      nextPrompt: string,
      document: ReturnType<
        ReturnType<typeof createHandoffRecorder>["document"]
      >,
      reason: string,
      from: SubagentMeta,
    ) =>
      Effect.gen(function* () {
        if (currentScope) {
          yield* closeSegment(currentScope);
          segments.delete(currentScope);
        }
        handoffCount++;
        const continuationPrompt = buildContinuationPrompt({
          originalPrompt: task.prompt,
          nextPrompt,
          handoff: document,
        });
        const next = yield* openSegment(continuationPrompt);
        const to = yield* next.meta;
        emit({
          _tag: "Handoff",
          fromSessionId: from.nativeSessionId,
          fromSessionFile: from.sessionFilePath,
          toSessionId: to.nativeSessionId,
          toSessionFile: to.sessionFilePath,
          reason: reason || `handoff ${handoffCount}`,
          summary: formatHandoffDocument(document),
        });
        suppressSegmentEvents = false;
      });

    const waitForInternalHandoff = () =>
      new Promise<RunOutcome | undefined>((resolve) => {
        const timer = setTimeout(() => {
          if (handoffWaiter) handoffWaiter = undefined;
          resolve(undefined);
        }, 45_000);
        handoffWaiter = (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        };
      });

    const requestAgentHandoff = (reason: string) =>
      Effect.gen(function* () {
        const session = currentSession;
        if (!session) return recorder.document(reason);
        const fallback = recorder.document(reason);
        suppressSegmentEvents = true;
        try {
          const waiting = waitForInternalHandoff();
          const sent = yield* session
            .send(handoffSummaryInstructions())
            .pipe(Effect.result);
          if (Result.isFailure(sent)) return fallback;
          const outcome = yield* Effect.promise(() => waiting);
          if (outcome?._tag !== "Completed") return fallback;
          return handoffDocumentFromAgentText(outcome.finalText, fallback);
        } finally {
          suppressSegmentEvents = false;
        }
      });

    const rollover = (nextPrompt: string) =>
      Effect.gen(function* () {
        const decision = handoffDecision(latestUsage);
        if (!decision.shouldHandoff || !currentScope || !currentSession) {
          yield* currentSession?.send(nextPrompt) ??
            new SendError({ message: "Pi handoff session is not available." });
          return;
        }
        const from = yield* currentSession.meta;
        const reason = decision.reason ?? "handoff policy";
        const document = yield* requestAgentHandoff(reason);
        yield* continueInFreshSegment(nextPrompt, document, reason, from);
      });

    yield* openSegment(task.prompt);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        for (const scope of segments) yield* closeSegment(scope);
        Queue.endUnsafe(events);
      }),
    );

    return {
      meta: Effect.sync(() => currentMeta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          const session = currentSession;
          if (!session) {
            return new SendError({ message: "Pi session is not available." });
          }
          if (active) return session.send(text);
          return rollover(text).pipe(
            Effect.mapError((error) =>
              error instanceof SendError
                ? error
                : new SendError({ message: boundedError(error) }),
            ),
          );
        }),
      interrupt: Effect.suspend(() => currentSession?.interrupt ?? Effect.void),
    } satisfies SubagentSession;
  });

const makePiSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> => {
  if (task.resume || task.schema !== undefined) {
    return makePiSessionSegment(task);
  }
  return makePiHandoffSession(task, makePiSessionSegment);
};

export const piBackend: SubagentBackend = {
  name: "pi",
  capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
  // In-process SDK: always available.
  available: Effect.succeed(true),
  spawn: makePiSession,
};
