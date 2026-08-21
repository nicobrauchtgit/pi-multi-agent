import * as http from "node:http";
import { createStatements } from "./db/statements.mjs";
import { checkpointAndClose, openDatabase } from "./db/open.mjs";
import { verifyDatabaseFiles } from "./fsguard.mjs";
import { startHttpServer } from "./http/server.mjs";
import { readLock, processIsAlive } from "./lock.mjs";
import { createLogger } from "./log.mjs";
import { quickCheckDatabase } from "./maintenance.mjs";
import { createMetrics } from "./metrics.mjs";
import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "./constants.mjs";
import {
  cleanupAtomicTemps,
  readJson,
  readToken,
  removeMatchingState,
  rotateTokens,
  writeAtomicJson,
} from "./state.mjs";

function requestJson(options, body) {
  return new Promise((resolve) => {
    const request = http.request(options, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 64 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        if (bytes > 64 * 1024) return resolve(null);
        try {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(1_000, () => request.destroy());
    request.on("error", () => resolve(null));
    if (body) request.end(body);
    else request.end();
  });
}

export async function reuseRunningDaemon(paths) {
  try {
    const lock = readLock(paths.lock);
    const state = readJson(paths.state);
    if (
      !lock ||
      !processIsAlive(lock.pid) ||
      state.startToken !== lock.startToken ||
      state.pid !== lock.pid ||
      state.protocolVersion !== PROTOCOL_VERSION ||
      state.buildVersion !== BUILD_VERSION ||
      state.schemaVersion !== SCHEMA_VERSION ||
      !Number.isInteger(state.port)
    ) {
      return false;
    }
    const host = `127.0.0.1:${state.port}`;
    const health = await requestJson({
      host: "127.0.0.1",
      port: state.port,
      path: "/healthz",
      method: "GET",
      headers: { Host: host },
    });
    if (
      health?.status !== 200 ||
      health.body?.ready !== true ||
      health.body?.protocolVersion !== PROTOCOL_VERSION ||
      health.body?.buildVersion !== BUILD_VERSION
    ) {
      return false;
    }
    const token = readToken(paths.ingestToken);
    const body = '{"v":1,"events":[]}';
    const probe = await requestJson(
      {
        host: "127.0.0.1",
        port: state.port,
        path: "/v1/ingest",
        method: "POST",
        headers: {
          Host: host,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      body,
    );
    return probe?.status === 200 && probe.body?.accepted === 0;
  } catch {
    return false;
  }
}

export async function runDaemon(paths, lock, options = {}) {
  let opened;
  let server;
  let starting = true;
  let pendingShutdownReason;
  let shuttingDown = false;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  const logger = createLogger(paths.log);
  let metrics;

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.write("shutdown_started", { reason });
    try {
      if (server) await server.close();
    } finally {
      try {
        metrics?.flush();
      } catch {
        // Counter loss on shutdown is explicitly best effort.
      }
      if (opened?.db) {
        try {
          checkpointAndClose(opened.db);
        } catch {
          // Lock/state cleanup remains token checked.
        }
      }
      removeMatchingState(paths.state, lock.record.startToken);
      lock.release();
      logger.write("shutdown_complete", { reason });
      resolveStopped?.();
    }
  };

  const requestShutdown = (reason) => {
    if (starting) {
      pendingShutdownReason = reason;
      return;
    }
    void shutdown(reason);
  };
  const onSigterm = () => requestShutdown("sigterm");
  const onSigint = () => requestShutdown("sigint");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    cleanupAtomicTemps(paths.root);
    opened = openDatabase(paths.database, {
      ...(process.env.PI_OBSERVABILITY_TEST_MIGRATION_FAIL === "1"
        ? { injectFailureAt: 1 }
        : {}),
    });
    verifyDatabaseFiles(paths);
    quickCheckDatabase(opened.db);
    const tokens = rotateTokens(paths);
    metrics = createMetrics(paths.metrics);
    metrics.flush();
    const statements = createStatements(opened.db);
    const health = { ready: false, degraded: false };
    let lastReceivedAt = 0;
    server = await startHttpServer({
      db: opened.db,
      statements,
      ingestToken: tokens.ingest,
      metrics,
      logger,
      health,
      startedAt: lock.record.startedAt,
      idleMs: options.idleMs,
      nextReceivedAt: () => {
        lastReceivedAt = Math.max(lastReceivedAt + 129, Date.now());
        return lastReceivedAt;
      },
      onIdle: () => requestShutdown("idle"),
    });
    if (pendingShutdownReason) {
      starting = false;
      await shutdown(pendingShutdownReason);
      await stopped;
      return;
    }
    writeAtomicJson(paths.state, {
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      port: server.port,
      startedAt: lock.record.startedAt,
      startToken: lock.record.startToken,
      buildVersion: BUILD_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
    health.ready = true;
    starting = false;
    logger.write("daemon_ready", {
      port: server.port,
      schemaVersion: SCHEMA_VERSION,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, code: "ready", port: server.port })}\n`,
    );
    await stopped;
  } catch (error) {
    if (server) {
      try {
        await server.close();
      } catch {
        // Startup error remains authoritative.
      }
    }
    if (opened?.db) {
      try {
        opened.db.close();
      } catch {
        // Startup error remains authoritative.
      }
    }
    removeMatchingState(paths.state, lock.record.startToken);
    lock.release();
    throw error;
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }
}
