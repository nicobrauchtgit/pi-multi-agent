import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  READ_LIMITS,
  SCHEMA_VERSION,
} from "../constants.mjs";
import { receiveBatch, StorageError } from "../ingest/receive.mjs";
import { parseBatch, RequestValidationError } from "../ingest/validate.mjs";
import {
  enforceExactHost,
  enforceIngestHeaders,
  enforceNoRequestBody,
  enforceOriginHeaders,
  enforceReadHeaders,
  HttpError,
  readBoundedBody,
  setAssetSecurityHeaders,
  setDocumentSecurityHeaders,
  setSecurityHeaders,
} from "./auth.mjs";
import { createReadRouter } from "./read.mjs";
import { staticAssetFor } from "./static.mjs";

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > READ_LIMITS.responseBytes) {
    throw new HttpError(500, "response-too-large", true);
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  setSecurityHeaders(response);
  response.end(body);
}

function empty(response, status, options = {}) {
  response.statusCode = status;
  response.setHeader("Content-Length", "0");
  if (options.allow) response.setHeader("Allow", options.allow);
  setSecurityHeaders(response);
  response.end();
}

function staticResponse(response, asset) {
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.contentType);
  response.setHeader("Content-Length", asset.contentLength);
  if (asset.kind === "document") setDocumentSecurityHeaders(response);
  else setAssetSecurityHeaders(response);
  response.end(asset.body);
}

function requestPath(request) {
  if (typeof request.url !== "string") return "";
  const query = request.url.indexOf("?");
  return query === -1 ? request.url : request.url.slice(0, query);
}

export function createRoutes(options) {
  const readRoute = createReadRouter({
    statements: options.readStatements,
    metrics: options.metrics,
    health: options.health,
    config: options.config,
    startedAt: options.startedAt,
    sizeSnapshot: options.sizeSnapshot,
  });

  return async function route(request, response) {
    setSecurityHeaders(response);
    const path = requestPath(request);
    const isIngest = request.method === "POST" && request.url === "/v1/ingest";
    try {
      enforceExactHost(request, options.port());

      if (request.method === "GET" && request.url === "/healthz") {
        enforceOriginHeaders(request, { api: true });
        enforceNoRequestBody(request);
        json(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          buildVersion: BUILD_VERSION,
          schemaVersion: SCHEMA_VERSION,
          ready: options.health.ready,
          degraded: options.health.degraded,
          uptimeMs: Math.max(0, Date.now() - options.startedAt),
        });
        return;
      }

      if (isIngest) {
        if (!options.health.ready) throw new HttpError(503, "not-ready", true);
        enforceIngestHeaders(request, options.port(), options.ingestToken);
        const text = await readBoundedBody(request);
        const events = parseBatch(text);
        const now = options.nextReceivedAt();
        const result = receiveBatch(options.db, events, now, {
          statements: options.statements,
          metrics: options.metrics,
          policyConfig: options.config?.current(),
        });
        options.health.degraded = false;
        options.metrics.flush();
        options.onActivity();
        json(response, 200, result);
        return;
      }

      if (path.startsWith("/v1/")) {
        if (!options.health.ready) throw new HttpError(503, "not-ready", true);
        enforceReadHeaders(request, options.port(), options.readToken);
        const result = readRoute(request);
        options.onActivity();
        json(response, 200, result);
        return;
      }

      const asset = staticAssetFor(options.staticAssets, path);
      if (asset) {
        enforceOriginHeaders(request, {
          allowTopLevelNavigation: path === "/",
          allowedOrigin:
            path === "/" ? undefined : `http://127.0.0.1:${options.port()}`,
        });
        if (request.method !== "GET") {
          const error = new HttpError(405, "method-not-allowed");
          error.allow = "GET";
          throw error;
        }
        enforceNoRequestBody(request);
        staticResponse(response, asset);
        return;
      }

      enforceOriginHeaders(request);
      empty(response, 404);
    } catch (error) {
      const classified =
        error instanceof HttpError ||
        error instanceof RequestValidationError ||
        error instanceof StorageError;
      const status = classified ? error.status : 500;
      const code =
        classified && typeof error.code === "string"
          ? error.code
          : "internal-error";
      if (isIngest) {
        if (status < 500) options.metrics.reject(code);
        else options.health.degraded = true;
        try {
          options.metrics.flush();
        } catch {
          // The response remains metadata-only even if counters cannot flush.
        }
      }
      options.logger.write("request_rejected", { status, code });
      if (isIngest || (error instanceof HttpError && error.close)) {
        response.setHeader("Connection", "close");
      }
      if (error && typeof error === "object" && error.allow) {
        response.setHeader("Allow", error.allow);
      }
      const body =
        error && typeof error === "object" && error.body
          ? error.body
          : { error: code };
      try {
        json(response, status, body);
      } catch {
        if (!response.headersSent) empty(response, 500);
        else response.end();
      }
      if (error instanceof HttpError && error.close) {
        response.once("finish", () => request.destroy());
      }
    }
  };
}
