import * as http from "node:http";
import type { ObservabilityEvent } from "../../shared/observability/events.ts";
import type { ObservabilityPaths } from "../../shared/observability/home.mjs";
import { OBSERVABILITY_LIMITS } from "../../shared/observability/normalize.mjs";
import { readProtectedJson, readProtectedText } from "./protected-fs.ts";
import type { ReplayResult } from "./spool.ts";

const RESPONSE_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;
const TRANSIENT_RETRY_DELAYS_MS = [100, 400] as const;

interface DaemonState {
  readonly protocolVersion: 1;
  readonly port: number;
  readonly pid: number;
  readonly startToken: string;
  readonly buildVersion?: string;
}

export class DaemonTransportError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, transient: boolean) {
    super(code);
    this.name = "DaemonTransportError";
    this.code = code;
    this.transient = transient;
  }
}

function daemonState(value: unknown): DaemonState {
  const input = value as Partial<DaemonState> | undefined;
  if (
    input?.protocolVersion !== 1 ||
    !Number.isInteger(input.port) ||
    Number(input.port) < 1 ||
    Number(input.port) > 65_535 ||
    !Number.isInteger(input.pid) ||
    Number(input.pid) < 1 ||
    typeof input.startToken !== "string" ||
    input.startToken.length < 16
  ) {
    throw new DaemonTransportError("invalid-daemon-state", true);
  }
  return input as DaemonState;
}

function ingestToken(value: string) {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new DaemonTransportError("invalid-ingest-token", true);
  }
  return token;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function requestJson(
  agent: http.Agent,
  state: DaemonState,
  token: string,
  body: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const host = `127.0.0.1:${state.port}`;
    const request = http.request(
      {
        host: "127.0.0.1",
        port: state.port,
        path: "/v1/ingest",
        method: "POST",
        agent,
        headers: {
          Host: host,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "keep-alive",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= RESPONSE_MAX_BYTES) chunks.push(chunk);
        });
        response.on("end", () => {
          if (bytes > RESPONSE_MAX_BYTES) {
            reject(new DaemonTransportError("response-too-large", false));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new DaemonTransportError("invalid-response", false));
            return;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new DaemonTransportError("request-timeout", true));
    });
    request.once("error", (error) => {
      reject(
        error instanceof DaemonTransportError
          ? error
          : new DaemonTransportError("network-unavailable", true),
      );
    });
    request.end(body);
  });
}

export function createDaemonTransport(options: {
  paths: ObservabilityPaths;
  ensureDaemon?: () => Promise<unknown>;
  onHealth?: (
    state: "healthy" | "degraded" | "unavailable",
    reason: string,
  ) => void;
}) {
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
  });
  let closed = false;
  let blockedStartToken: string | undefined;
  let ensureInFlight: Promise<unknown> | undefined;
  let lastEnsureAt = 0;

  const triggerEnsure = () => {
    if (!options.ensureDaemon || closed || Date.now() - lastEnsureAt < 1_000)
      return;
    lastEnsureAt = Date.now();
    ensureInFlight ??= options
      .ensureDaemon()
      .catch(() => undefined)
      .finally(() => {
        ensureInFlight = undefined;
      });
  };

  const discover = () => {
    const state = daemonState(
      readProtectedJson(options.paths.state, 64 * 1024),
    );
    const token = ingestToken(
      readProtectedText(options.paths.ingestToken, 256),
    );
    return { state, token };
  };

  const send = async (
    events: readonly ObservabilityEvent<string, Record<string, unknown>>[],
  ): Promise<ReplayResult> => {
    if (closed) return { terminal: events.map(() => false) };
    if (events.length > OBSERVABILITY_LIMITS.batchEvents) {
      throw new DaemonTransportError("batch-event-limit", false);
    }
    const body = JSON.stringify({ v: 1, events });
    if (Buffer.byteLength(body, "utf8") > OBSERVABILITY_LIMITS.batchBytes) {
      throw new DaemonTransportError("batch-byte-limit", false);
    }

    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= TRANSIENT_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      if (attempt > 0) await delay(TRANSIENT_RETRY_DELAYS_MS[attempt - 1]);
      try {
        const { state, token } = discover();
        if (blockedStartToken === state.startToken) {
          throw new DaemonTransportError("protocol-mismatch", false);
        }
        if (blockedStartToken !== undefined) blockedStartToken = undefined;
        const response = await requestJson(agent, state, token, body);
        if (response.status === 200) {
          const results = (response.body as { results?: unknown })?.results;
          if (!Array.isArray(results) || results.length !== events.length) {
            throw new DaemonTransportError("invalid-ack", false);
          }
          options.onHealth?.("healthy", "ingest-ready");
          return {
            terminal: results.map((result) =>
              ["accepted", "duplicate", "conflict", "rejected"].includes(
                (result as { status?: string } | undefined)?.status ?? "",
              ),
            ),
          };
        }
        if (response.status === 401) {
          lastError = new DaemonTransportError("token-rotated", true);
          continue;
        }
        if (response.status === 409) {
          blockedStartToken = state.startToken;
          options.onHealth?.("degraded", "protocol-mismatch");
          throw new DaemonTransportError("protocol-mismatch", false);
        }
        if (response.status === 503) {
          lastError = new DaemonTransportError("daemon-unavailable", true);
          continue;
        }
        if (response.status >= 500) {
          options.onHealth?.("degraded", "ingest-server-error");
        }
        throw new DaemonTransportError("ingest-rejected", false);
      } catch (error) {
        lastError = error;
        if (!(error instanceof DaemonTransportError) || !error.transient)
          throw error;
      }
    }
    options.onHealth?.("unavailable", "transport-unavailable");
    triggerEnsure();
    throw lastError ?? new DaemonTransportError("daemon-unavailable", true);
  };

  return Object.freeze({
    send,
    close() {
      closed = true;
      agent.destroy();
    },
  });
}

export type DaemonTransport = ReturnType<typeof createDaemonTransport>;
