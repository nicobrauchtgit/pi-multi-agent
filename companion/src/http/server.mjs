import * as http from "node:http";
import { LIMITS } from "../constants.mjs";
import { setSecurityHeaders } from "./auth.mjs";
import { createRoutes } from "./routes.mjs";

export async function startHttpServer(options) {
  let port = 0;
  let inFlight = 0;
  let lastActivity = Date.now();
  let stopping = false;
  const sockets = new Set();
  const route = createRoutes({
    ...options,
    port: () => port,
    onActivity: () => {
      lastActivity = Date.now();
    },
  });

  const server = http.createServer((request, response) => {
    if (stopping || inFlight >= LIMITS.inflightRequests) {
      response.statusCode = 503;
      response.setHeader("Content-Length", "0");
      response.setHeader("Connection", "close");
      setSecurityHeaders(response);
      response.end();
      return;
    }
    inFlight++;
    let finished = false;
    const settle = () => {
      if (finished) return;
      finished = true;
      inFlight--;
    };
    response.once("finish", settle);
    response.once("close", settle);
    Promise.resolve(route(request, response)).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Length", "0");
        setSecurityHeaders(response);
      }
      response.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = 64;
  server.on("checkContinue", (_request, response) => {
    response.writeHead(417, { Connection: "close", "Content-Length": "0" });
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (error, socket) => {
    options.logger.write("client_error", {
      code:
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "parse-error",
    });
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  ) {
    server.close();
    throw new Error("loopback-bind-failed");
  }
  port = address.port;

  const idleMs = Math.max(1_000, options.idleMs ?? 30 * 60 * 1_000);
  const idleTimer = setInterval(
    () => {
      if (!stopping && inFlight === 0 && Date.now() - lastActivity >= idleMs) {
        options.onIdle();
      }
    },
    Math.min(30_000, Math.max(500, Math.floor(idleMs / 4))),
  );
  idleTimer.unref();

  return Object.freeze({
    port,
    async close() {
      if (stopping) return;
      stopping = true;
      clearInterval(idleTimer);
      options.health.ready = false;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve(undefined);
        }, 20_000);
        timeout.unref?.();
        server.close(() => {
          clearTimeout(timeout);
          resolve(undefined);
        });
        server.closeIdleConnections?.();
      });
    },
  });
}
