import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "../constants.mjs";
import { receiveBatch, StorageError } from "../ingest/receive.mjs";
import { parseBatch, RequestValidationError } from "../ingest/validate.mjs";
import {
  enforceExactHost,
  enforceIngestHeaders,
  HttpError,
  readBoundedBody,
  setSecurityHeaders,
} from "./auth.mjs";

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  setSecurityHeaders(response);
  response.end(body);
}

function notFound(response) {
  response.statusCode = 404;
  response.setHeader("Content-Length", "0");
  setSecurityHeaders(response);
  response.end();
}

export function createRoutes(options) {
  return async function route(request, response) {
    setSecurityHeaders(response);
    if (request.method === "GET" && request.url === "/healthz") {
      try {
        enforceExactHost(request, options.port());
        json(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          buildVersion: BUILD_VERSION,
          schemaVersion: SCHEMA_VERSION,
          ready: options.health.ready,
          degraded: options.health.degraded,
          uptimeMs: Math.max(0, Date.now() - options.startedAt),
        });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        json(response, error.status, { error: error.code });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/ingest") {
      notFound(response);
      return;
    }

    try {
      if (!options.health.ready) throw new HttpError(503, "not-ready", true);
      enforceIngestHeaders(request, options.port(), options.ingestToken);
      const text = await readBoundedBody(request);
      const events = parseBatch(text);
      const now = options.nextReceivedAt();
      const result = receiveBatch(options.db, events, now, {
        statements: options.statements,
        metrics: options.metrics,
      });
      options.health.degraded = false;
      options.metrics.flush();
      options.onActivity();
      json(response, 200, result);
    } catch (error) {
      const status =
        error instanceof HttpError ||
        error instanceof RequestValidationError ||
        error instanceof StorageError
          ? error.status
          : 500;
      const code =
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "internal-error";
      if (status < 500) options.metrics.reject(code);
      else options.health.degraded = true;
      try {
        options.metrics.flush();
      } catch {
        // The response remains metadata-only even if counters cannot flush.
      }
      options.logger.write("request_rejected", { status, code });
      response.setHeader("Connection", "close");
      json(response, status, { error: code });
      if (error instanceof HttpError && error.close) {
        response.once("finish", () => request.destroy());
      }
    }
  };
}
