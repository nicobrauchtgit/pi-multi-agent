import { spawn } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import type { ObservabilityPaths } from "../../shared/observability/home.mjs";
import { readProtectedJson, readProtectedText } from "./protected-fs.ts";

export type DaemonHealth =
  "unknown" | "starting" | "healthy" | "degraded" | "unavailable";

const STARTUP_BUDGET_MS = 3_000;
const HEALTH_TIMEOUT_MS = 500;
const PROBE_INTERVAL_MS = 50;

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function openObservabilityUi(
  url: string,
  options: { platform?: NodeJS.Platform; spawnProcess?: typeof spawn } = {},
) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/.test(url)) {
    return Promise.reject(new Error("invalid-observability-url"));
  }
  const platform = options.platform ?? process.platform;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "cmd.exe"
        : "xdg-open";
  const args =
    platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  return new Promise<void>((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("browser-open-failed")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function boundedState(value: unknown) {
  const state = value as {
    protocolVersion?: unknown;
    buildVersion?: unknown;
    port?: unknown;
    pid?: unknown;
    startToken?: unknown;
  };
  if (
    state?.protocolVersion !== 1 ||
    !Number.isInteger(state.port) ||
    Number(state.port) < 1 ||
    Number(state.port) > 65_535 ||
    !Number.isInteger(state.pid) ||
    Number(state.pid) < 1 ||
    typeof state.startToken !== "string" ||
    state.startToken.length < 16
  ) {
    throw new Error("invalid-daemon-state");
  }
  return state as {
    protocolVersion: 1;
    buildVersion?: string;
    port: number;
    pid: number;
    startToken: string;
  };
}

function probeState(paths: ObservabilityPaths) {
  return boundedState(readProtectedJson(paths.state, 64 * 1024));
}

function requestReady(
  state: ReturnType<typeof boundedState>,
  options: { token?: string; scope?: "ingest" | "read" } = {},
) {
  return new Promise<boolean>((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: state.port,
        method: options.scope === "ingest" ? "POST" : "GET",
        path:
          options.scope === "ingest"
            ? "/v1/ingest"
            : options.scope === "read"
              ? "/v1/status"
              : "/healthz",
        headers: options.token
          ? {
              Host: `127.0.0.1:${state.port}`,
              Authorization: `Bearer ${options.token}`,
              ...(options.scope === "ingest"
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": 19,
                  }
                : {}),
            }
          : { Host: `127.0.0.1:${state.port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 64 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200 || bytes > 64 * 1024) {
            resolve(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(
              options.scope === "ingest"
                ? body?.accepted === 0
                : body?.ready === true && body?.protocolVersion === 1,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.setTimeout(HEALTH_TIMEOUT_MS, () => request.destroy());
    request.once("error", () => resolve(false));
    request.end(options.scope === "ingest" ? '{"v":1,"events":[]}' : undefined);
  });
}

export function createDaemonController(options: {
  paths: ObservabilityPaths;
  autostart: boolean;
  onTransition?: (state: DaemonHealth, reason: string) => void;
  daemonEntry?: string;
  startupBudgetMs?: number;
}) {
  let health: DaemonHealth = "unknown";
  let reason = "not-checked";
  let permanentUnavailable = false;
  let ensuring: Promise<boolean> | undefined;

  const transition = (next: DaemonHealth, nextReason: string) => {
    if (health === next && reason === nextReason) return;
    health = next;
    reason = nextReason.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 80);
    options.onTransition?.(health, reason);
  };

  const probe = async () => {
    try {
      const state = probeState(options.paths);
      if (!(await requestReady(state))) return false;
      const token = readProtectedText(options.paths.ingestToken, 256).trim();
      if (
        /^[A-Za-z0-9_-]{43}$/.test(token) &&
        (await requestReady(state, { token, scope: "ingest" }))
      ) {
        transition("healthy", "daemon-ready");
        return true;
      }
    } catch {
      // Absence and protected-state validation both fall back to spool mode.
    }
    return false;
  };

  const start = async () => {
    if (await probe()) return true;
    if (!options.autostart || permanentUnavailable) {
      transition(
        "unavailable",
        permanentUnavailable ? "runtime-unavailable" : "autostart-disabled",
      );
      return false;
    }
    transition("starting", "cold-start");
    const daemonEntry =
      options.daemonEntry ??
      path.resolve(import.meta.dirname, "../../../companion/daemon.mjs");
    let child;
    try {
      child = spawn(
        process.execPath,
        [daemonEntry, "start", "--agent-dir", options.paths.agentDir],
        {
          cwd: path.dirname(path.dirname(daemonEntry)),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env },
        },
      );
      child.unref();
    } catch {
      transition("unavailable", "spawn-failed");
      return false;
    }

    let exitCode: number | null | undefined;
    child.once("exit", (code) => {
      exitCode = code;
      if (code === 69) {
        permanentUnavailable = true;
        transition("unavailable", "runtime-unavailable");
      }
    });
    const deadline =
      Date.now() + (options.startupBudgetMs ?? STARTUP_BUDGET_MS);
    while (Date.now() < deadline) {
      if (await probe()) return true;
      // 72 means another starter won before state became complete; keep polling.
      if (
        exitCode !== undefined &&
        exitCode !== null &&
        ![0, 72].includes(exitCode)
      ) {
        if (exitCode === 69) permanentUnavailable = true;
        break;
      }
      await delay(PROBE_INTERVAL_MS);
    }
    transition(
      permanentUnavailable ? "unavailable" : "degraded",
      permanentUnavailable ? "runtime-unavailable" : "startup-timeout",
    );
    return false;
  };

  const ensureDaemon = () => {
    ensuring ??= start().finally(() => {
      ensuring = undefined;
    });
    return ensuring;
  };

  return Object.freeze({
    ensureDaemon,
    async readUiUrl() {
      if (!(await ensureDaemon())) throw new Error("daemon-unavailable");
      try {
        const state = probeState(options.paths);
        const token = readProtectedText(options.paths.readToken, 256).trim();
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(token) ||
          !(await requestReady(state, { token, scope: "read" }))
        ) {
          throw new Error("read-scope-unavailable");
        }
        return `http://127.0.0.1:${state.port}/#${token}`;
      } catch {
        throw new Error("read-scope-unavailable");
      }
    },
    probe,
    reportTransportState(
      next: "healthy" | "degraded" | "unavailable",
      nextReason: string,
    ) {
      transition(next, nextReason);
    },
    get state() {
      return { health, reason, permanentUnavailable } as const;
    },
  });
}

export type DaemonController = ReturnType<typeof createDaemonController>;
