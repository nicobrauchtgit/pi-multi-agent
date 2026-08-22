/**
 * Subagents — spawn background subagents on one of three backends
 * (pi, Claude Code, Codex) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort, optional schema/persistent role). Max 4 running at once
 *   across all backends.
 * - subagent_followup: continue/steer a tracked subagent in this Pi session.
 * - subagent_resume: reopen a persistent role's native backend history.
 * - subagent_roles/subagent_forget: list/remove persistent role records.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All three backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to a scoped `codex app-server` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  assertChildWorkingDirectoryAllowed,
  configureChildProtectedPaths,
  isChildExtensionLoad,
  processRichCaptureAllowed,
} from "../shared/child-session.ts";
import { ensureBlackboard, withBlackboard } from "../shared/hunk-blackboard.ts";
import { observabilityPaths } from "../shared/observability/home.mjs";
import { parentIdentityFromPiSession } from "../shared/observability/ids.ts";
import {
  NOOP_OBSERVABILITY_SINK,
  type ObservabilitySink,
} from "../shared/observability/sink.ts";
import {
  disposeProcessService,
  provideProcessService,
  type ProcessServiceHandle,
} from "../shared/service-registry.ts";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  createDaemonController,
  openObservabilityUi,
  type DaemonController,
} from "./src/daemon-control.ts";
import { createParentHookObserver } from "./src/parent-hooks.ts";
import { loadProducerConfig } from "./src/producer-config.ts";
import {
  createProducerSink,
  type ProducerObservabilitySink,
} from "./src/producer-sink.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  formatStructuredResult,
  structuredResultDetails,
  structuredResultWaitBudget,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS,
  SUBAGENT_RESUME_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import {
  createDeferredResultDelivery,
  resultDeliveryChannel,
} from "./src/result-delivery.ts";
import {
  codexJsonSchemaCompatibilityError,
  jsonSchemaValidationError,
} from "../shared/json-schema.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { acquireRoleLock } from "./src/role-lock.ts";
import {
  forgetRole,
  getRole,
  listRoles,
  normalizeAndValidateRoleName,
  roleUpsertFromSnapshot,
  updateRole,
  upsertRole,
  type PersistentSubagentRecord,
} from "./src/roles.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
const OBSERVABILITY_TEST_AGENT_DIR_KEY = Symbol.for(
  "pi-multi-agent.observability.test-agent-dir.v1",
);

function observabilityTestAgentDir() {
  const root = globalThis as typeof globalThis & {
    [OBSERVABILITY_TEST_AGENT_DIR_KEY]?: string;
  };
  const configured =
    root[OBSERVABILITY_TEST_AGENT_DIR_KEY] ??
    process.env.PI_OBSERVABILITY_TEST_AGENT_DIR;
  if (configured) root[OBSERVABILITY_TEST_AGENT_DIR_KEY] = configured;
  // Parent-test control only: never expose this companion path to a child or
  // grandchild environment, including in-process Pi shell tools.
  delete process.env.PI_OBSERVABILITY_TEST_AGENT_DIR;
  return configured;
}

function schemaParameter(description: string) {
  return Type.Object(
    {},
    {
      additionalProperties: true,
      description,
    },
  );
}

function assertStructuredSchema(schema: unknown, backend?: string) {
  const error = jsonSchemaValidationError(schema);
  if (error) throw new Error(`Invalid structured output schema: ${error}.`);
  if (backend === "codex") {
    const compatibilityError = codexJsonSchemaCompatibilityError(schema);
    if (compatibilityError) {
      throw new Error(
        `Codex structured output schema is unsupported: ${compatibilityError}.`,
      );
    }
  }
}

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  const structured = snap.schemaError
    ? " [structured invalid]"
    : snap.structured !== undefined
      ? " [structured ok]"
      : "";
  return `${snap.id} [${snap.status}]${structured} "${snap.title}"${snap.role ? ` <${snap.role}>` : ""} (${details.join(", ")})`;
}

function describeRole(
  record: PersistentSubagentRecord,
  active?: SubagentSnapshot,
) {
  const status = active
    ? `${record.status}; active ${active.id} [${active.status}]`
    : record.status;
  const details = [
    `${record.backend}: ${record.modelLabel ?? record.model ?? "?"}`,
    record.cwd,
    record.sessionFilePath ? `session ${record.sessionFilePath}` : undefined,
    record.nativeSessionId ? `native ${record.nativeSessionId}` : undefined,
    record.schema ? "structured" : undefined,
    record.schemaError,
  ].filter(Boolean);
  return `${record.role} [${status}] "${record.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  if (isChildExtensionLoad()) return;

  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let serviceHandle:
    ProcessServiceHandle<SubagentRuntime, SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let serviceSessionId: string | undefined;
  let sessionActive = false;
  let serviceInitializationError: string | undefined;
  let ownedSink: ObservabilitySink = NOOP_OBSERVABILITY_SINK;
  let producerSink: ProducerObservabilitySink | undefined;
  let daemonController: DaemonController | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();
  const roleMetaFingerprints = new Map<string, string>();
  // Test-only override keeps live acceptance daemon/storage isolated while Pi
  // continues using its normal models/auth/config directory.
  const paths = observabilityPaths(observabilityTestAgentDir());
  const parentHooks = createParentHookObserver({
    getSink: () => producerSink,
  });

  const initializeService = () => {
    if (!sessionActive || !sessionContext) {
      throw new Error("The subagent session is not active.");
    }
    if (serviceInitializationError) {
      throw new Error(serviceInitializationError);
    }
    if (runtime && managerPromise && serviceHandle?.isCurrent()) return;

    const loadedConfig = loadProducerConfig(paths);
    configureChildProtectedPaths({
      agentDir: getAgentDir(),
      moshiPaths: loadedConfig.config.moshiPaths,
      additionalRoots: [paths.root],
    });
    let createdSink: ObservabilitySink = NOOP_OBSERVABILITY_SINK;
    let createdProducer: ProducerObservabilitySink | undefined;
    let createdController: DaemonController | undefined;
    if (!loadedConfig.valid && ui) {
      ui.setStatus("observability", "observability: disabled");
      ui.notify(
        `Local observability configuration failed closed (${loadedConfig.reason ?? "invalid"}).`,
        "warning",
      );
    }
    if (loadedConfig.valid && loadedConfig.config.capture !== "off") {
      try {
        const richAllowed = processRichCaptureAllowed();
        const richForcedMetadata =
          loadedConfig.config.capture === "rich" && !richAllowed;
        createdController = createDaemonController({
          paths,
          autostart: loadedConfig.config.autostart,
          onTransition: (health, reason) => {
            if (ui) {
              ui.setStatus(
                "observability",
                health === "healthy"
                  ? richForcedMetadata
                    ? "observability: metadata-only"
                    : undefined
                  : `observability: ${health}`,
              );
              ui.notify(
                health === "healthy"
                  ? "Local observability daemon is healthy."
                  : `Local observability is ${health} (${reason}); orchestration continues in bounded spool mode.`,
                health === "healthy" ? "info" : "warning",
              );
            }
          },
        });
        createdProducer = createProducerSink({
          paths,
          config: loadedConfig.config,
          // Shared same-UID storage plus unbounded shell/Codex reads make rich
          // unsafe today. An explicit rich config is narrowed to metadata.
          richAllowed,
          ensureDaemon: () => createdController!.ensureDaemon(),
          onHealth: (health, reason) =>
            createdController?.reportTransportState(health, reason),
        });
        if (richForcedMetadata) {
          createdProducer.recordDiagnostic("rich-forced-metadata");
          if (ui) {
            ui.setStatus("observability", "observability: metadata-only");
            ui.notify(
              "Rich observability was forced to metadata-only because one or more child backends lack a protected same-UID read/shell boundary.",
              "warning",
            );
          }
        }
        createdSink = createdProducer;
      } catch (error) {
        createdController = undefined;
        createdProducer = undefined;
        createdSink = NOOP_OBSERVABILITY_SINK;
        if (ui) {
          const reason =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "producer-initialization-failed";
          ui.setStatus("observability", "observability: disabled");
          ui.notify(
            `Local observability initialization failed closed (${reason}); subagent and workflow tools remain available.`,
            "warning",
          );
        }
      }
    }
    const createdRuntime = createSubagentRuntime(createdSink);
    const createdManager = createdRuntime
      .runPromise(SubagentManager)
      .then((manager) => {
        // closeOwnedService invalidates ownership synchronously before awaiting
        // this promise. A late manager must not reinstall listeners afterward.
        if (
          runtime !== createdRuntime ||
          managerPromise !== createdManager ||
          !serviceHandle?.isCurrent()
        ) {
          return manager;
        }
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => {
          updateStatus(manager);
          syncRoleMetadata(manager);
        });
        updateStatus(manager);
        syncRoleMetadata(manager);
        return manager;
      });
    let createdHandle: ProcessServiceHandle<
      SubagentRuntime,
      SubagentManagerShape
    >;
    try {
      createdHandle = provideProcessService({
        runtime: createdRuntime,
        manager: createdManager,
        sink: createdSink,
      });
    } catch (error) {
      void createdRuntime.dispose();
      throw error;
    }
    runtime = createdRuntime;
    managerPromise = createdManager;
    serviceHandle = createdHandle;
    ownedSink = createdSink;
    producerSink = createdProducer;
    daemonController = createdController;
  };

  const getRuntime = () => {
    initializeService();
    return runtime!;
  };

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    initializeService();
    return managerPromise!;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { running, done, failed }),
    );
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
          structured: snap.structured,
          schemaError: snap.schemaError,
        }),
        display: true,
        details: {
          id: snap.id,
          title: snap.title,
          status: snap.status,
          structured: structuredResultDetails(snap.structured),
          schemaError: snap.schemaError,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const persistRoleSnapshot = (
    snap: SubagentSnapshot,
    extras: Parameters<typeof roleUpsertFromSnapshot>[1] = {},
    resetNativeLocator = false,
  ) => {
    if (snap.origin !== "model") return;
    const upsert = roleUpsertFromSnapshot(snap, {
      parentPiSessionId: sessionContext?.sessionManager.getSessionId(),
      ...extras,
    });
    if (!upsert) return;
    try {
      upsertRole({ ...upsert, resetNativeLocator });
    } catch {
      // Role persistence must not affect subagent lifecycle/result delivery.
    }
  };

  /** Persist native locators as soon as backend metadata arrives. */
  const syncRoleMetadata = (manager: SubagentManagerShape) => {
    for (const snap of manager.view.list()) {
      if (
        snap.origin !== "model" ||
        !snap.role ||
        (!snap.meta.sessionFilePath && !snap.meta.nativeSessionId)
      ) {
        continue;
      }
      const fingerprint = JSON.stringify({
        role: snap.role,
        modelLabel: snap.meta.modelLabel,
        sessionFilePath: snap.meta.sessionFilePath,
        nativeSessionId: snap.meta.nativeSessionId,
      });
      if (roleMetaFingerprints.get(snap.id) === fingerprint) continue;
      roleMetaFingerprints.set(snap.id, fingerprint);
      persistRoleSnapshot(snap);
    }
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "workflow") {
      resultDelivery.consume([snap.id]);
      return;
    }
    const deliveryChannel = resultDeliveryChannel(snap);
    if (deliveryChannel === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    persistRoleSnapshot(snap);
    if (deliveryChannel === "none" || consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  const closeOwnedService = async (reason: string) => {
    resultDelivery.clear();
    roleMetaFingerprints.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    const closingRuntime = runtime;
    const closingManager = managerPromise;
    const closingHandle = serviceHandle;
    const closingSink = ownedSink;
    const closingProducer = producerSink;
    runtime = undefined;
    managerPromise = undefined;
    serviceHandle = undefined;
    serviceSessionId = undefined;
    ownedSink = NOOP_OBSERVABILITY_SINK;
    producerSink = undefined;
    daemonController = undefined;
    if (closingHandle) {
      disposeProcessService(closingHandle.ownerToken, reason);
    }
    // Settle manager-owned workflow collectors before ManagedRuntime disposal
    // can interrupt their fused collection fibers.
    try {
      const manager = await closingManager;
      if (closingRuntime && manager) {
        await closingRuntime.runPromise(manager.disposeAll);
      }
    } catch {
      // Runtime disposal remains the final bounded cleanup.
    }
    if (closingHandle) {
      if (closingProducer) await closingProducer.close(250).catch(() => {});
      else await closingSink.flush(250).catch(() => {});
    }
    await closingRuntime?.dispose();
  };

  pi.on("session_start", async (_event, ctx) => {
    const nextSessionId = ctx.sessionManager.getSessionId();
    if (serviceHandle) {
      sessionActive = false;
      sessionContext = undefined;
      await closeOwnedService(
        serviceSessionId === nextSessionId
          ? "Subagent extension was reloaded"
          : "Parent Pi session was replaced",
      );
    }
    sessionContext = ctx;
    serviceSessionId = nextSessionId;
    sessionActive = true;
    serviceInitializationError = undefined;
    if (ctx.hasUI) ui = ctx.ui;
    try {
      initializeService();
      parentHooks.sessionStart(_event, ctx);
      // Lazy, once-per-service autostart. Startup and agent work never wait.
      void daemonController?.ensureDaemon();
    } catch (error) {
      serviceInitializationError = `Subagent service initialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (ctx.hasUI) ctx.ui.notify(serviceInitializationError, "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    flushResults();
    // Print mode exits after this run and has no later interactive prompt. Some
    // hosts tear it down without a separately awaitable shutdown hook, so seal
    // the root run here; session_shutdown is idempotent if it follows.
    if (ctx.mode === "print") {
      parentHooks.sessionShutdown({ reason: "agent-settled" }, ctx);
      await producerSink?.flush(250).catch(() => {});
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    parentHooks.sessionShutdown(event, ctx);
    sessionActive = false;
    sessionContext = undefined;
    serviceInitializationError = undefined;
    ui?.setStatus("subagents", undefined);
    ui?.setStatus("observability", undefined);
    ui = undefined;
    await closeOwnedService("Subagent service was reloaded or shut down");
  });

  parentHooks.register(pi);

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: StringEnum(BACKEND_NAMES, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
      role: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.role,
        }),
      ),
      schema: Type.Optional(
        schemaParameter(SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.schema),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.schema !== undefined) {
        assertStructuredSchema(params.schema, params.harness);
      }
      const manager = await getManager();
      const harness = params.harness;

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }
      assertChildWorkingDirectoryAllowed(cwd);

      const title = params.name.trim().slice(0, 160) || "subagent";
      const role = params.role
        ? normalizeAndValidateRoleName(params.role)
        : undefined;
      // Share a Hunk blackboard across agents working in this repo (best-effort).
      const blackboard = await ensureBlackboard(cwd);
      const roleLease = role ? acquireRoleLock(role) : undefined;
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: withBlackboard(params.prompt, blackboard),
          title,
          cwd,
          role,
          roleLease,
          schema: params.schema,
          model: params.model,
          reasoningEffort: params.reasoning_effort,
          parent: {
            parentCwd: ctx.cwd,
            ...parentIdentityFromPiSession(ctx.sessionManager.getSessionId()),
            projectTrusted: resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
        { signal, interruptMessage: "Subagent spawn aborted." },
      );

      persistRoleSnapshot(
        snap,
        {
          model: params.model,
          reasoningEffort: params.reasoning_effort,
          schema: params.schema,
          parentPiSessionId: ctx.sessionManager.getSessionId(),
        },
        true,
      );

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
              role,
              structured: params.schema !== undefined,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          harness,
          model: snap.meta.modelLabel,
          role,
          structured: structuredResultDetails(snap.structured),
          schemaError: snap.schemaError,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        if (snap.schemaError) section += `\nSchema error: ${snap.schemaError}`;
        if (snap.structured !== undefined) {
          section += `\n\nStructured result:\n\`\`\`json\n${formatStructuredResult(
            snap.structured,
            structuredResultWaitBudget(remainingBytes),
          )}\n\`\`\``;
        }
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return {
              id,
              title: snap?.title,
              status: snap?.status,
              structured: structuredResultDetails(snap?.structured),
              schemaError: snap?.schemaError,
            };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;
      if (snap.schemaError) text += `\nSchema error: ${snap.schemaError}`;
      if (snap.structured !== undefined) {
        text += `\n\nStructured result:\n\`\`\`json\n${formatStructuredResult(
          snap.structured,
          8 * 1024,
        )}\n\`\`\``;
      }

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: {
          id: snap.id,
          status: snap.status,
          turns: snap.turns,
          structured: structuredResultDetails(snap.structured),
          schemaError: snap.schemaError,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
            role: snap.role,
            structured: structuredResultDetails(snap.structured, 1024),
            schemaError: snap.schemaError,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_followup",
    label: "Follow Up Subagent",
    description:
      "Send a follow-up prompt to a tracked subagent in this Pi session. If it is running, the backend steers/queues the message; if it is settled, this starts a new turn in the same native session. A schema-bearing subagent must produce a fresh validated structured result for each turn. This does not resume agents after Pi restart.",
    parameters: Type.Object({
      id: Type.String({
        description: "Current-session subagent id, e.g. sa-1",
      }),
      prompt: Type.String({
        description:
          "Follow-up prompt to send. Include enough context for the subagent to continue correctly.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }
      const prompt = params.prompt.trim();
      if (!prompt)
        throw new Error("subagent_followup requires a non-empty prompt.");

      await runTool(getRuntime(), manager.send(snap.id, prompt), {
        signal,
        interruptMessage: "Subagent follow-up aborted.",
      });
      if (snap.role) {
        try {
          updateRole(snap.role, {
            title: snap.title,
            backend: snap.backend,
            cwd: snap.cwd,
            modelLabel: snap.meta.modelLabel,
            sessionFilePath: snap.meta.sessionFilePath,
            nativeSessionId: snap.meta.nativeSessionId,
            lastSubagentId: snap.id,
            status: "running",
            parentPiSessionId: sessionContext?.sessionManager.getSessionId(),
          });
        } catch {
          // Role persistence is best-effort.
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent follow-up to ${snap.id} "${snap.title}"${snap.role ? ` (role ${snap.role})` : ""}.`,
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          role: snap.role,
          structured: structuredResultDetails(snap.structured),
          schemaError: snap.schemaError,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent Role",
    description: SUBAGENT_RESUME_TOOL_DESCRIPTION,
    parameters: Type.Object({
      role: Type.String({
        description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.role,
      }),
      prompt: Type.String({
        description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.prompt,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
      schema: Type.Optional(
        schemaParameter(SUBAGENT_RESUME_PARAMETER_DESCRIPTIONS.schema),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.schema !== undefined) assertStructuredSchema(params.schema);
      const manager = await getManager();
      const role = normalizeAndValidateRoleName(params.role);
      const prompt = params.prompt.trim();
      if (!prompt)
        throw new Error("subagent_resume requires a non-empty prompt.");

      const tracked = manager.view
        .list()
        .find((snap) => isModelVisible(snap) && snap.role === role);
      const record = getRole(role);
      if (!tracked && !record) {
        throw new Error(`No persistent subagent role named "${role}".`);
      }
      if (!tracked && record?.schemaError && params.schema === undefined) {
        throw new Error(
          `Role "${role}" cannot be resumed: ${record.schemaError} Supply a replacement schema or forget and recreate the role.`,
        );
      }

      if (
        tracked &&
        params.schema !== undefined &&
        !isDeepStrictEqual(tracked.schema, params.schema)
      ) {
        throw new Error(
          `Role "${role}" is active and its structured-output schema cannot be changed until it is reopened.`,
        );
      }

      const savedCwd = tracked?.cwd ?? record!.cwd;
      // A tracked role already owns a live native session; reopen-only
      // overrides must not rewrite that session's cwd/model metadata.
      const cwd = tracked
        ? tracked.cwd
        : params.working_dir
          ? path.resolve(ctx.cwd, params.working_dir)
          : savedCwd;
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        if (!tracked && !params.working_dir && record) {
          try {
            updateRole(role, { status: "missing" });
          } catch {
            // Preserve the primary validation error.
          }
        }
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }
      assertChildWorkingDirectoryAllowed(cwd);

      if (!tracked && record?.backend === "pi") {
        const sessionFile = record.sessionFilePath;
        if (
          !sessionFile ||
          !fs.existsSync(sessionFile) ||
          !fs.statSync(sessionFile).isFile()
        ) {
          try {
            updateRole(role, { status: "missing" });
          } catch {
            // Preserve the primary validation error.
          }
          throw new Error(
            `Pi session history for role "${role}" is missing: ${sessionFile ?? "no session file recorded"}.`,
          );
        }
      }
      if (
        !tracked &&
        record &&
        record.backend !== "pi" &&
        !record.nativeSessionId
      ) {
        try {
          updateRole(role, { status: "missing" });
        } catch {
          // Preserve the primary validation error.
        }
        throw new Error(
          `${record.backend} role "${role}" has no native session id to resume.`,
        );
      }

      const backend = tracked?.backend ?? record!.backend;
      const model = tracked ? undefined : (params.model ?? record?.model);
      const reasoningEffort = tracked
        ? undefined
        : (params.reasoning_effort ?? record?.reasoningEffort);
      const schema = tracked
        ? tracked.schema
        : (params.schema ?? record?.schema);
      if (schema !== undefined && backend === "codex") {
        assertStructuredSchema(schema, backend);
      }

      // Refresh rather than trusting a Hunk session cached before a Pi restart.
      const blackboard = await ensureBlackboard(cwd, { refresh: true });
      const followUp = withBlackboard(prompt, blackboard);
      const roleLease = tracked ? undefined : acquireRoleLock(role);

      const result = await runTool(
        getRuntime(),
        manager.resumeRole(backend, {
          prompt: followUp,
          title: tracked?.title ?? record!.title,
          cwd,
          role,
          roleLease,
          schema,
          resume: record
            ? {
                sessionFilePath: record.sessionFilePath,
                nativeSessionId: record.nativeSessionId,
              }
            : undefined,
          model,
          reasoningEffort,
          parent: {
            parentCwd: ctx.cwd,
            ...parentIdentityFromPiSession(ctx.sessionManager.getSessionId()),
            projectTrusted: resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
        { signal, interruptMessage: "Subagent resume aborted." },
      );

      try {
        updateRole(role, {
          title: result.snapshot.title,
          backend: result.snapshot.backend,
          cwd,
          model,
          modelLabel: result.snapshot.meta.modelLabel,
          reasoningEffort,
          schema,
          clearSchema: tracked !== undefined && schema === undefined,
          sessionFilePath: result.snapshot.meta.sessionFilePath,
          nativeSessionId: result.snapshot.meta.nativeSessionId,
          lastSubagentId: result.snapshot.id,
          status: "running",
          parentPiSessionId: ctx.sessionManager.getSessionId(),
        });
      } catch {
        // Role persistence remains best-effort after the native session starts.
      }

      const text = result.reopened
        ? `Resumed role ${role} as ${result.snapshot.id} "${result.snapshot.title}" (${backend}: ${result.snapshot.meta.modelLabel ?? "?"}, ${cwd}).`
        : `Sent follow-up to ${result.snapshot.id} "${result.snapshot.title}" (role ${role}).`;
      return {
        content: [{ type: "text", text }],
        details: {
          id: result.snapshot.id,
          title: result.snapshot.title,
          role,
          harness: backend,
          cwd,
          reopened: result.reopened,
          structured: structuredResultDetails(result.snapshot.structured),
          schemaError: result.snapshot.schemaError,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_roles",
    label: "List Subagent Roles",
    description:
      "List persistent subagent role records, including the native session locator used by subagent_resume after a Pi restart.",
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const activeByRole = new Map(
        manager.view
          .list()
          .filter((snap) => isModelVisible(snap) && snap.role)
          .map((snap) => [snap.role!, snap] as const),
      );
      const roles = listRoles();
      const text =
        roles.length === 0
          ? "No persistent subagent roles."
          : roles
              .map((record) =>
                describeRole(record, activeByRole.get(record.role)),
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          roles: roles.map(({ schema, ...record }) => ({
            ...record,
            schema: structuredResultDetails(schema, 1024),
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_forget",
    label: "Forget Subagent Role",
    description:
      "Remove a persistent subagent role record. This only removes Pi's role index; it does not delete native Pi/Claude/Codex transcript history.",
    parameters: Type.Object({
      role: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.role,
      }),
    }),
    async execute(_toolCallId, params) {
      const role = normalizeAndValidateRoleName(params.role);
      const removed = forgetRole(role);
      return {
        content: [
          {
            type: "text",
            text: removed
              ? `Forgot subagent role ${role}. Native transcript/history was not deleted.`
              : `No persistent subagent role named ${role}.`,
          },
        ],
        details: { role, removed },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            ...parentIdentityFromPiSession(ctx.sessionManager.getSessionId()),
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("observability", {
    description: "Open the local read-only observability UI",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "The observability browser command is only available in the local TUI.",
            "error",
          );
        }
        return;
      }
      try {
        initializeService();
        if (!daemonController) throw new Error("observability-disabled");
        const url = await daemonController.readUiUrl();
        await openObservabilityUi(url);
        ctx.ui.notify("Opened the local read-only observability UI.", "info");
      } catch {
        ctx.ui.notify(
          "The local observability UI is unavailable. Orchestration is unaffected.",
          "error",
        );
      }
    },
  });

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
