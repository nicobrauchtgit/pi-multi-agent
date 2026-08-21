import { createHash, timingSafeEqual } from "node:crypto";
import { LIMITS } from "../constants.mjs";

export class HttpError extends Error {
  constructor(status, code, close = false) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.close = close;
  }
}

export function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function bearerMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const left = digest(supplied);
  const right = digest(token);
  return timingSafeEqual(left, right) && supplied.length === token.length;
}

function singleRawHeader(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count === 1;
}

export function enforceExactHost(request, port) {
  const expectedHost = `127.0.0.1:${port}`;
  if (
    !singleRawHeader(request, "host") ||
    request.headers.host !== expectedHost
  ) {
    throw new HttpError(400, "invalid-host");
  }
}

export function enforceIngestHeaders(request, port, token) {
  enforceExactHost(request, port);
  if (
    request.headers.origin !== undefined ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    throw new HttpError(403, "cross-origin-rejected");
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw new HttpError(415, "unsupported-content-type");
  }
  const length = request.headers["content-length"];
  if (length !== undefined) {
    if (Array.isArray(length) || !/^\d+$/.test(length))
      throw new HttpError(400, "invalid-content-length");
    if (Number(length) > LIMITS.batchBytes)
      throw new HttpError(413, "body-too-large", true);
  }
  if (
    !singleRawHeader(request, "authorization") ||
    !bearerMatches(request.headers.authorization, token)
  ) {
    throw new HttpError(401, "unauthorized");
  }
}

export function readBoundedBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const fail = (error) => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.pause();
      reject(error);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > LIMITS.batchBytes) {
        fail(new HttpError(413, "body-too-large", true));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolve(Buffer.concat(chunks, bytes).toString("utf8"));
    const onError = () => fail(new HttpError(400, "body-read-failed", true));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}
