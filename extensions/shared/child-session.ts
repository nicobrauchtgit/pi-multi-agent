import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const CHILD_EXTENSION_SCOPE_KEY = Symbol.for(
  "pi-multi-agent.child-extension-load-scope.v1",
);

function childExtensionScope() {
  const root = globalThis as typeof globalThis & {
    [CHILD_EXTENSION_SCOPE_KEY]?: AsyncLocalStorage<boolean>;
  };
  return (root[CHILD_EXTENSION_SCOPE_KEY] ??= new AsyncLocalStorage<boolean>());
}

/** True only while an in-process child is loading or binding extensions. */
export function isChildExtensionLoad() {
  return childExtensionScope().getStore() === true;
}

function canonicalEntry(entry: string, cwd = process.cwd()) {
  if (!path.isAbsolute(entry) && /^[a-z][a-z0-9+.-]*:/i.test(entry)) {
    return undefined;
  }
  const resolved = path.resolve(cwd, entry);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const sharedDirectory = path.dirname(fileURLToPath(import.meta.url));
const CHILD_BLOCKED_EXTENSION_ENTRIES = [
  path.resolve(sharedDirectory, "../subagents"),
  path.resolve(sharedDirectory, "../subagents/index.ts"),
  path.resolve(sharedDirectory, "../workflows"),
  path.resolve(sharedDirectory, "../workflows/index.ts"),
];

/** Remove only this repository's orchestration entry points from child settings. */
export function filterChildExtensionPaths(
  extensions: ReadonlyArray<string>,
  blockedEntries: ReadonlyArray<string> = CHILD_BLOCKED_EXTENSION_ENTRIES,
) {
  const blocked = new Set(
    blockedEntries
      .map((entry) => canonicalEntry(entry))
      .filter((entry): entry is string => entry !== undefined),
  );
  return extensions.filter((entry) => {
    const canonical = canonicalEntry(entry);
    return canonical === undefined || !blocked.has(canonical);
  });
}

function isAllowedChildExtensionPath(entry: string) {
  return filterChildExtensionPaths([entry]).length === 1;
}

/**
 * SettingsManager.reload() replaces applyOverrides(), and PackageManager reads
 * the scoped settings rather than getExtensionPaths(). Wrap all three getters
 * so every resource reload sees the denylist without persisting child-only
 * settings back to the parent's settings.json.
 */
function installChildExtensionSettingsFilter(settingsManager: SettingsManager) {
  const getGlobalSettings =
    settingsManager.getGlobalSettings.bind(settingsManager);
  const getProjectSettings =
    settingsManager.getProjectSettings.bind(settingsManager);
  const getExtensionPaths =
    settingsManager.getExtensionPaths.bind(settingsManager);
  settingsManager.getGlobalSettings = () => {
    const settings = getGlobalSettings();
    return {
      ...settings,
      extensions: filterChildExtensionPaths(settings.extensions ?? []),
    };
  };
  settingsManager.getProjectSettings = () => {
    const settings = getProjectSettings();
    return {
      ...settings,
      extensions: filterChildExtensionPaths(settings.extensions ?? []),
    };
  };
  settingsManager.getExtensionPaths = () =>
    filterChildExtensionPaths(getExtensionPaths());
}

/** Tools that headless children must not receive. Everything else stays enabled. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "subagent_followup",
  "subagent_resume",
  "subagent_roles",
  "subagent_forget",
  "workflow",
  "ask_user",
] as const;

/** Fresh SDK options avoid turning the denylist into an accidental allowlist. */
export function childToolPolicy() {
  return { excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES] };
}

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  installChildExtensionSettingsFilter(settingsManager);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    // Settings filtering prevents configured orchestration entries from being
    // resolved. The final filter also removes an auto-discovered/symlink alias;
    // its factory runs in the child scope below and therefore returns early.
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) =>
        isAllowedChildExtensionPath(extension.resolvedPath),
      ),
    }),
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await childExtensionScope().run(true, () => loader.reload());
  return { loader, settingsManager };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

/** Start child extension session hooks/resources in headless print mode. */
export async function bindChildSessionExtensions(
  session: Pick<AgentSession, "bindExtensions">,
) {
  await childExtensionScope().run(true, () =>
    session.bindExtensions({ mode: "print" }),
  );
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

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

/**
 * Emit child session_shutdown once, then dispose once. Hook failures and a
 * bounded hook deadline never prevent disposal.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        );
      }
    } catch {
      // Extension runner inspection/emission is best-effort during teardown.
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
