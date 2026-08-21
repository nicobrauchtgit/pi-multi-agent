import { spawnSync } from "node:child_process";
import { EXIT } from "./constants.mjs";

export const MINIMUM_NODE = Object.freeze([22, 5, 0]);
export const SQLITE_REEXEC_SENTINEL = "PI_OBSERVABILITY_SQLITE_REEXEC";

export class RuntimeUnavailableError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "RuntimeUnavailableError";
    this.code = "runtime-unavailable";
    this.exitCode = EXIT.UNAVAILABLE;
    this.detail = detail;
  }
}

export function parseNodeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1, 4).map(Number) : [0, 0, 0];
}

export function isSupportedNodeVersion(value) {
  const actual = parseNodeVersion(value);
  for (let index = 0; index < MINIMUM_NODE.length; index++) {
    if (actual[index] > MINIMUM_NODE[index]) return true;
    if (actual[index] < MINIMUM_NODE[index]) return false;
  }
  return true;
}

export async function probeNodeSqlite(importer = () => import("node:sqlite")) {
  try {
    const sqlite = await importer();
    if (typeof sqlite.DatabaseSync !== "function") {
      return { ok: false, reason: "DatabaseSync unavailable" };
    }
    const database = new sqlite.DatabaseSync(":memory:");
    database.close();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "node:sqlite unavailable",
    };
  }
}

/**
 * Probe before importing any module that statically imports node:sqlite. On
 * early Node 22 builds the built-in may require one guarded flag re-exec.
 */
export async function ensureRuntime(options = {}) {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new RuntimeUnavailableError("node-version-too-old", {
      required: "22.5.0",
      actual: nodeVersion,
    });
  }

  const probe = await probeNodeSqlite(options.importer);
  if (probe.ok) return { reexec: false };

  const env = options.env ?? process.env;
  if (env[SQLITE_REEXEC_SENTINEL] !== "1" && options.allowReexec !== false) {
    const argv = options.argv ?? process.argv.slice(1);
    const spawn = options.spawn ?? spawnSync;
    const child = spawn(process.execPath, ["--experimental-sqlite", ...argv], {
      stdio: "inherit",
      env: { ...env, [SQLITE_REEXEC_SENTINEL]: "1" },
    });
    return {
      reexec: true,
      status: child.status ?? EXIT.UNAVAILABLE,
      signal: child.signal ?? undefined,
    };
  }

  throw new RuntimeUnavailableError("node-sqlite-unavailable", {
    required: "node:sqlite DatabaseSync",
  });
}
