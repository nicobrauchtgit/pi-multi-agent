import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_SECRET_EXCLUDE_PATHS = Object.freeze([
  ".env*",
  "*.pem",
  "*.key",
  ".ssh/**",
  ".aws/**",
  ".azure/**",
  ".config/gcloud/**",
  ".netrc",
  ".npmrc",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
]);

export const DEFAULT_OBSERVABILITY_CONFIG = Object.freeze({
  version: 1,
  capture: "metadata",
  autostart: true,
  defaults: Object.freeze({
    enabled: true,
    contentMode: "metadata",
    excludePaths: DEFAULT_SECRET_EXCLUDE_PATHS,
    retentionDays: 30,
    maxDatabaseBytes: 1024 * 1024 * 1024,
    maxSpoolBytes: 64 * 1024 * 1024,
  }),
  projects: Object.freeze([]),
  moshiPaths: Object.freeze([]),
});

const CONTENT_MODE_RANK = Object.freeze({ disabled: 0, metadata: 1, rich: 2 });
const CONFIG_MAX_BYTES = 256 * 1024;
const CONFIG_MAX_PROJECTS = 256;
const CONFIG_MAX_PATTERNS = 256;
const CONFIG_STRING_MAX_BYTES = 4 * 1024;

function configError(reason) {
  return Object.assign(new Error(reason), { code: reason });
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function boundedString(value, reason) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > CONFIG_STRING_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw configError(reason);
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, reason) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configError(reason);
  }
  return value;
}

function contentMode(value, fallback, reason) {
  if (value === undefined) return fallback;
  if (!(value in CONTENT_MODE_RANK)) throw configError(reason);
  return value;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Resolve through the nearest existing ancestor so symlink aliases cannot evade matching. */
export function canonicalizePath(value, cwd = process.cwd()) {
  const expanded = expandHome(boundedString(value, "invalid-path"));
  const resolved = path.resolve(cwd, expanded);
  let cursor = resolved;
  const suffix = [];
  while (true) {
    try {
      const canonical = fs.realpathSync.native(cursor);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw configError("path-canonicalization-failed");
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function pathContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function stringList(value, fallback, reason) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > CONFIG_MAX_PATTERNS) {
    throw configError(reason);
  }
  return value.map((entry) => boundedString(entry, reason));
}

function normalizedDefaults(value) {
  const input = record(value) ?? {};
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw configError("invalid-default-enabled");
  }
  return Object.freeze({
    enabled: input.enabled ?? true,
    contentMode: contentMode(
      input.contentMode,
      DEFAULT_OBSERVABILITY_CONFIG.defaults.contentMode,
      "invalid-default-content-mode",
    ),
    excludePaths: Object.freeze(
      stringList(
        input.excludePaths,
        DEFAULT_SECRET_EXCLUDE_PATHS,
        "invalid-default-exclude-paths",
      ),
    ),
    retentionDays: boundedInteger(
      input.retentionDays,
      DEFAULT_OBSERVABILITY_CONFIG.defaults.retentionDays,
      1,
      3650,
      "invalid-retention-days",
    ),
    maxDatabaseBytes: boundedInteger(
      input.maxDatabaseBytes,
      DEFAULT_OBSERVABILITY_CONFIG.defaults.maxDatabaseBytes,
      1024 * 1024,
      Number.MAX_SAFE_INTEGER,
      "invalid-max-database-bytes",
    ),
    maxSpoolBytes: boundedInteger(
      input.maxSpoolBytes,
      DEFAULT_OBSERVABILITY_CONFIG.defaults.maxSpoolBytes,
      1024 * 1024,
      1024 * 1024 * 1024,
      "invalid-max-spool-bytes",
    ),
  });
}

/** Parse and canonicalize the daemon-authoritative project policy. */
export function normalizePolicyConfig(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CONFIG_MAX_BYTES) {
    throw configError("config-too-large");
  }
  const input = record(value);
  if (!input || (input.version !== undefined && input.version !== 1)) {
    throw configError("invalid-config-version");
  }
  const capture = input.capture ?? DEFAULT_OBSERVABILITY_CONFIG.capture;
  if (!["off", "metadata", "rich"].includes(capture)) {
    throw configError("invalid-capture-mode");
  }
  if (input.autostart !== undefined && typeof input.autostart !== "boolean") {
    throw configError("invalid-autostart");
  }
  const defaults = normalizedDefaults(input.defaults);
  const rawProjects = input.projects ?? [];
  if (!Array.isArray(rawProjects) || rawProjects.length > CONFIG_MAX_PROJECTS) {
    throw configError("invalid-projects");
  }
  const projects = rawProjects.map((entry) => {
    const project = record(entry);
    if (!project) throw configError("invalid-project");
    const root = canonicalizePath(
      boundedString(project.root, "invalid-project-root"),
    );
    if (project.enabled !== undefined && typeof project.enabled !== "boolean") {
      throw configError("invalid-project-enabled");
    }
    return Object.freeze({
      root,
      ...(project.enabled === undefined ? {} : { enabled: project.enabled }),
      ...(project.contentMode === undefined
        ? {}
        : {
            contentMode: contentMode(
              project.contentMode,
              defaults.contentMode,
              "invalid-project-content-mode",
            ),
          }),
      ...(project.excludePaths === undefined
        ? {}
        : {
            excludePaths: Object.freeze(
              stringList(
                project.excludePaths,
                [],
                "invalid-project-exclude-paths",
              ),
            ),
          }),
    });
  });
  projects.sort(
    (left, right) =>
      right.root.length - left.root.length ||
      left.root.localeCompare(right.root),
  );
  const moshiPaths = Object.freeze(
    stringList(input.moshiPaths, [], "invalid-moshi-paths").map((entry) =>
      canonicalizePath(entry),
    ),
  );
  return Object.freeze({
    version: 1,
    capture,
    autostart: input.autostart ?? true,
    defaults,
    projects: Object.freeze(projects),
    moshiPaths,
  });
}

export function defaultPolicyConfig() {
  return normalizePolicyConfig(DEFAULT_OBSERVABILITY_CONFIG);
}

export function minimumContentMode(...modes) {
  let selected = "rich";
  for (const mode of modes) {
    if (!(mode in CONTENT_MODE_RANK)) continue;
    if (CONTENT_MODE_RANK[mode] < CONTENT_MODE_RANK[selected]) selected = mode;
  }
  return selected;
}

/**
 * Longest canonical root wins. Missing project attribution is never allowed to
 * inherit a rich default: unattributed events fail closed to metadata (or to
 * disabled when capture/default policy is disabled).
 */
export function resolveProjectPolicy(config, projectRoot) {
  const root = projectRoot ? canonicalizePath(projectRoot) : undefined;
  const match = root
    ? config.projects.find((project) => pathContains(project.root, root))
    : undefined;
  const enabled = match?.enabled ?? config.defaults.enabled;
  const configuredMode = root
    ? (match?.contentMode ?? config.defaults.contentMode)
    : minimumContentMode(config.defaults.contentMode, "metadata");
  const captureMode = config.capture === "off" ? "disabled" : config.capture;
  const contentMode = enabled
    ? minimumContentMode(configuredMode, captureMode)
    : "disabled";
  return Object.freeze({
    root,
    enabled: enabled && contentMode !== "disabled",
    contentMode,
    policyRoot: match?.root,
    policySource: match ? "project" : root ? "defaults" : "unattributed",
    excludePaths: Object.freeze([
      ...config.defaults.excludePaths,
      ...(match?.excludePaths ?? []),
    ]),
    retentionDays: config.defaults.retentionDays,
    maxDatabaseBytes: config.defaults.maxDatabaseBytes,
    maxSpoolBytes: config.defaults.maxSpoolBytes,
  });
}

function globExpression(pattern) {
  let output = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          output += "(?:.*/)?";
        } else output += ".*";
      } else output += "[^/]*";
    } else if (character === "?") output += "[^/]";
    else output += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${output}$`);
}

export function matchesExcludePath(relativePath, patterns) {
  const normalized = relativePath
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "");
  return patterns.some((pattern) => globExpression(pattern).test(normalized));
}

/** Classify known content provenance without returning sensitive file contents. */
export function classifyContentPath(options) {
  let candidate;
  try {
    candidate = canonicalizePath(
      options.value,
      options.cwd ?? options.projectRoot,
    );
  } catch {
    return Object.freeze({ excluded: true, classification: "unresolved" });
  }
  for (const root of [
    ...(options.protectedRoots ?? []),
    ...(options.moshiPaths ?? []),
  ]) {
    let canonicalRoot;
    try {
      canonicalRoot = canonicalizePath(root);
    } catch {
      continue;
    }
    if (pathContains(canonicalRoot, candidate)) {
      return Object.freeze({ excluded: true, classification: "protected" });
    }
  }
  if (options.projectRoot) {
    const projectRoot = canonicalizePath(options.projectRoot);
    if (pathContains(projectRoot, candidate)) {
      const relative = path.relative(projectRoot, candidate);
      if (
        matchesExcludePath(
          relative,
          options.excludePaths ?? DEFAULT_SECRET_EXCLUDE_PATHS,
        )
      ) {
        return Object.freeze({ excluded: true, classification: "secret-path" });
      }
    }
  }
  return Object.freeze({ excluded: false, classification: "ordinary" });
}
