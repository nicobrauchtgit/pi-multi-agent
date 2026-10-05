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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

function canonicalizePath(value: string, cwd: string = process.cwd()): string {
  const resolved = path.resolve(cwd, value);
  let cursor = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = fs.realpathSync.native(cursor);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        (error as { code?: unknown }).code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

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

const CHILD_PROTECTED_PATH_CONFIG_KEY = Symbol.for(
  "pi-multi-agent.child-protected-path-config.v1",
);

interface ChildProtectedPathConfig {
  readonly agentDir: string;
  readonly moshiPaths: readonly string[];
  readonly additionalRoots: readonly string[];
}

function childProtectedPathConfig(): ChildProtectedPathConfig {
  const root = globalThis as typeof globalThis & {
    [CHILD_PROTECTED_PATH_CONFIG_KEY]?: ChildProtectedPathConfig;
  };
  return (
    root[CHILD_PROTECTED_PATH_CONFIG_KEY] ?? {
      agentDir: getAgentDir(),
      moshiPaths: [],
      additionalRoots: [],
    }
  );
}

/** Parent-owned process configuration; values are never put in child prompts/env. */
export function configureChildProtectedPaths(config: ChildProtectedPathConfig) {
  if (isChildExtensionLoad()) {
    throw new Error(
      "Child extension loading cannot reconfigure protected paths.",
    );
  }
  const root = globalThis as typeof globalThis & {
    [CHILD_PROTECTED_PATH_CONFIG_KEY]?: ChildProtectedPathConfig;
  };
  root[CHILD_PROTECTED_PATH_CONFIG_KEY] = Object.freeze({
    agentDir: config.agentDir,
    moshiPaths: Object.freeze([...config.moshiPaths]),
    additionalRoots: Object.freeze([...config.additionalRoots]),
  });
}

export interface ProtectedPathDecision {
  readonly denied: boolean;
  readonly reason?: "protected-target" | "protected-search-root" | "unresolved";
}

export interface ProtectedPathPolicy {
  readonly roots: readonly string[];
  decide(toolName: string, input: unknown, cwd: string): ProtectedPathDecision;
  isProtected(candidate: string, cwd?: string): boolean;
}

const FILE_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "glob",
  "search",
  "apply_patch",
  "patch",
]);
const SEARCH_TOOL_NAMES = new Set(["grep", "find", "ls", "glob", "search"]);
const PATH_KEYS = new Set([
  "path",
  "file",
  "filepath",
  "file_path",
  "filename",
  "notebook_path",
  "paths",
  "directory",
  "cwd",
  "root",
  "include",
]);
const SEARCH_ROOT_KEYS = new Set(["path", "directory", "cwd", "root"]);
const SEARCH_GLOB_KEYS = new Set(["glob"]);

function globPrefix(value: string) {
  const index = value.search(/[?*[]/);
  if (index < 0) return value;
  const prefix = value.slice(0, index);
  const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf(path.sep));
  return slash < 0 ? "." : prefix.slice(0, slash + 1);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function keyedPathCandidates(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string[] {
  if (depth > 8 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => keyedPathCandidates(entry, keys, depth + 1))
      .slice(0, 256);
  }
  const output: string[] = [];
  for (const [key, child] of Object.entries(
    value as Record<string, unknown>,
  ).slice(0, 256)) {
    if (keys.has(key.toLowerCase())) output.push(...strings(child));
    else if (child && typeof child === "object") {
      output.push(...keyedPathCandidates(child, keys, depth + 1));
    }
    if (output.length >= 256) break;
  }
  return output.slice(0, 256);
}

function searchPatternCandidates(toolName: string, input: unknown) {
  const keys = new Set(SEARCH_GLOB_KEYS);
  // Pi/Claude find/glob patterns are filesystem globs. Grep's `pattern` is
  // content and must not be interpreted as a path, while grep.glob is a path.
  if (["find", "glob", "search"].includes(toolName)) keys.add("pattern");
  return keyedPathCandidates(input, keys);
}

/** Canonical protected inventory shared by standalone/workflow/resumed children. */
export function protectedPathPolicy(
  options: {
    agentDir?: string;
    moshiPaths?: readonly string[];
    additionalRoots?: readonly string[];
  } = {},
): ProtectedPathPolicy {
  const configured = childProtectedPathConfig();
  const agentDir = options.agentDir ?? configured.agentDir;
  const candidates = [
    path.join(agentDir, "multi-agent", "roles"),
    path.join(agentDir, "workflows"),
    path.join(agentDir, "multi-agent", "artifacts"),
    ...(options.moshiPaths ?? configured.moshiPaths),
    ...(options.additionalRoots ?? configured.additionalRoots),
  ];
  const roots = Object.freeze(
    [...new Set(candidates.map((entry) => canonicalizePath(entry)))].sort(),
  );

  const isProtected = (candidate: string, cwd = process.cwd()) => {
    try {
      const canonical = canonicalizePath(candidate.replace(/^@/, ""), cwd);
      return roots.some((root) => pathContains(root, canonical));
    } catch {
      return true;
    }
  };

  return Object.freeze({
    roots,
    isProtected,
    decide(toolName: string, input: unknown, cwd: string) {
      const normalizedTool = toolName.toLowerCase();
      if (!FILE_TOOL_NAMES.has(normalizedTool)) {
        return { denied: false } as const;
      }
      const search = SEARCH_TOOL_NAMES.has(normalizedTool);
      const explicitRoots = search
        ? keyedPathCandidates(input, SEARCH_ROOT_KEYS)
        : [];
      const candidates: Array<{
        raw: string;
        base: string;
        searchRoot: boolean;
      }> = [];
      if (search) {
        const searchRoots = explicitRoots.length > 0 ? explicitRoots : [cwd];
        for (const raw of searchRoots)
          candidates.push({ raw, base: cwd, searchRoot: true });
        for (const raw of searchPatternCandidates(normalizedTool, input)) {
          for (const base of searchRoots) {
            candidates.push({ raw, base, searchRoot: false });
          }
        }
      } else {
        for (const raw of keyedPathCandidates(input, PATH_KEYS)) {
          candidates.push({ raw, base: cwd, searchRoot: false });
        }
      }

      for (const candidate of candidates.slice(0, 256)) {
        let canonical: string;
        try {
          const base =
            search && !candidate.searchRoot
              ? canonicalizePath(candidate.base.replace(/^@/, ""), cwd)
              : candidate.base;
          canonical = canonicalizePath(
            globPrefix(candidate.raw.replace(/^@/, "")),
            base,
          );
        } catch {
          return { denied: true, reason: "unresolved" } as const;
        }
        if (roots.some((root) => pathContains(root, canonical))) {
          return { denied: true, reason: "protected-target" } as const;
        }
        if (
          (candidate.searchRoot || search) &&
          roots.some((root) => pathContains(canonical, root))
        ) {
          return {
            denied: true,
            reason: "protected-search-root",
          } as const;
        }
      }
      return { denied: false } as const;
    },
  });
}

/** Reject child cwd values inside or above any protected parent tree. */
export function assertChildWorkingDirectoryAllowed(
  candidate: string,
  policy: ProtectedPathPolicy = protectedPathPolicy(),
) {
  const canonical = canonicalizePath(candidate);
  if (
    policy.roots.some(
      (root) => pathContains(root, canonical) || pathContains(canonical, root),
    )
  ) {
    throw new ProtectedPathAccessError("working_dir");
  }
  return canonical;
}

export class ProtectedPathAccessError extends Error {
  constructor(toolName: string) {
    super(
      `Tool call "${toolName}" cannot access protected parent orchestration state.`,
    );
    this.name = "ProtectedPathAccessError";
  }
}

interface ChildToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/** Enforce supported Pi file/search tools at their actual execute boundary. */
export function createProtectedPathToolGuard(policy: ProtectedPathPolicy) {
  const wrapped = new WeakSet<ToolDefinition>();
  const wrap = (definition: ToolDefinition) => {
    if (wrapped.has(definition)) return;
    wrapped.add(definition);
    const execute = definition.execute;
    definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      const cwd =
        ctx &&
        typeof ctx === "object" &&
        "cwd" in ctx &&
        typeof ctx.cwd === "string"
          ? ctx.cwd
          : process.cwd();
      if (policy.decide(definition.name, params, cwd).denied) {
        throw new ProtectedPathAccessError(definition.name);
      }
      return execute.call(
        definition,
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    };
  };
  return Object.freeze({
    apply(session: ChildToolRegistry) {
      for (const { name } of session.getAllTools()) {
        const definition = session.getToolDefinition(name);
        if (definition) wrap(definition);
      }
    },
  });
}

/** Honest release gate: no backend currently has a proven shell boundary. */
export const CHILD_BACKEND_PATH_CAPABILITIES = Object.freeze({
  pi: Object.freeze({ fileTools: true, shell: false, richCapture: false }),
  claude: Object.freeze({ fileTools: true, shell: false, richCapture: false }),
  codex: Object.freeze({ fileTools: false, shell: false, richCapture: false }),
});

/** Copy the parent environment before passing it to an external child. */
export function childProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...source };
}

export function processRichCaptureAllowed(
  enabledBackends: readonly (keyof typeof CHILD_BACKEND_PATH_CAPABILITIES)[] = [
    "pi",
    "claude",
    "codex",
  ],
) {
  return enabledBackends.every(
    (backend) => CHILD_BACKEND_PATH_CAPABILITIES[backend].richCapture,
  );
}
