import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DOCUMENT_CSP, JSON_CSP } from "../src/http/auth.mjs";
import { loadStaticAssets, staticAssetFor } from "../src/http/static.mjs";
import {
  event,
  ingest,
  readRequest,
  request,
  startDaemon,
  tempAgentDir,
  waitFor,
} from "./helpers.mjs";

function host(daemon) {
  return `127.0.0.1:${daemon.state.port}`;
}

function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.end(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => (response += chunk));
    socket.once("end", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
      resolve({ status: match ? Number(match[1]) : 0, response });
    });
    socket.once("error", reject);
  });
}

function assertCommonHeaders(response, csp) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["content-security-policy"], csp);
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers["last-modified"], undefined);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
}

async function oneEventDaemon(t, extra = []) {
  const daemon = await startDaemon(t, tempAgentDir(t), extra);
  const accepted = await ingest(daemon, [
    event({
      eventId: "event-d3-security",
      producer: { seq: 1 },
      payload: { name: "<script>globalThis.pwned=true</script>" },
    }),
  ]);
  assert.equal(accepted.status, 200);
  return daemon;
}

test("read/static routes enforce Host, Origin, fetch metadata, methods, and no bodies", async (t) => {
  const daemon = await oneEventDaemon(t);
  const wrongHost = await readRequest(daemon, "/v1/status", {
    headers: { Host: `localhost:${daemon.state.port}` },
  });
  assert.equal(wrongHost.status, 400);
  const staticWrongHost = await request(daemon.state, {
    path: "/",
    headers: { Host: "evil.example" },
  });
  assert.equal(staticWrongHost.status, 400);
  const missingHost = await rawRequest(daemon.state.port, [
    "GET /v1/status HTTP/1.1",
    `Authorization: Bearer ${daemon.readToken}`,
    "Connection: close",
  ]);
  assert.equal(missingHost.status, 400);
  const duplicateHost = await rawRequest(daemon.state.port, [
    "GET /v1/status HTTP/1.1",
    `Host: ${host(daemon)}`,
    `Host: ${host(daemon)}`,
    `Authorization: Bearer ${daemon.readToken}`,
    "Connection: close",
  ]);
  assert.equal(duplicateHost.status, 400);
  const duplicateAuthorization = await rawRequest(daemon.state.port, [
    "GET /v1/status HTTP/1.1",
    `Host: ${host(daemon)}`,
    `Authorization: Bearer ${daemon.readToken}`,
    `Authorization: Bearer ${daemon.readToken}`,
    "Connection: close",
  ]);
  assert.equal(duplicateAuthorization.status, 401);

  const malformed = await rawRequest(daemon.state.port, [
    "GET / HTTP/1.1",
    `Host: ${host(daemon)}`,
    "Malformed Header",
  ]);
  assert.equal(malformed.status, 400);
  await waitFor(() => {
    if (!fs.existsSync(daemon.paths.log)) return undefined;
    return fs
      .readFileSync(daemon.paths.log, "utf8")
      .includes('"event":"client_error"')
      ? true
      : undefined;
  });
  const clientError = fs
    .readFileSync(daemon.paths.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === "client_error");
  assert.match(clientError.code, /^(?:HPE_[A-Z_]+|parse-error)$/);

  for (const pathName of ["/", "/v1/status"]) {
    const headers = {
      Host: host(daemon),
      Origin: `http://${host(daemon)}`,
      ...(pathName.startsWith("/v1/")
        ? { Authorization: `Bearer ${daemon.readToken}` }
        : {}),
    };
    const response = await request(daemon.state, { path: pathName, headers });
    assert.equal(response.status, 403, pathName);
  }
  const sameOriginModule = await request(daemon.state, {
    path: "/app.js",
    headers: { Host: host(daemon), Origin: `http://${host(daemon)}` },
  });
  assert.equal(sameOriginModule.status, 200);
  const crossOriginModule = await request(daemon.state, {
    path: "/app.js",
    headers: { Host: host(daemon), Origin: "http://evil.invalid" },
  });
  assert.equal(crossOriginModule.status, 403);

  for (const fetchSite of ["cross-site", "same-site"]) {
    const response = await readRequest(daemon, "/v1/status", {
      headers: { "Sec-Fetch-Site": fetchSite },
    });
    assert.equal(response.status, 403, fetchSite);
  }
  const destination = await readRequest(daemon, "/v1/status", {
    headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "document" },
  });
  assert.equal(destination.status, 403);
  const browserFetch = await readRequest(daemon, "/v1/status", {
    headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty" },
  });
  assert.equal(browserFetch.status, 200);
  const directNavigation = await request(daemon.state, {
    path: "/",
    headers: {
      Host: host(daemon),
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Dest": "document",
    },
  });
  assert.equal(directNavigation.status, 200);

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const read = await readRequest(daemon, "/v1/status", { method });
    assert.equal(read.status, 405, method);
    assert.equal(read.headers.allow, "GET");
    const shell = await request(daemon.state, {
      method,
      path: "/",
      headers: { Host: host(daemon) },
    });
    assert.equal(shell.status, 405, method);
    assert.equal(shell.headers.allow, "GET");
  }
  const body = await readRequest(daemon, "/v1/status", {
    body: "x",
  });
  assert.equal(body.status, 400);
  assert.equal(body.json.error, "request-body-not-allowed");

  const db = new DatabaseSync(daemon.paths.database, { readOnly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM events").get().value,
    1,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS value FROM runs").get().value, 1);
  db.close();
});

test("static UI is an exact startup allowlist with strict MIME, CSP, and cache behavior", async (t) => {
  const daemon = await oneEventDaemon(t);
  const expected = [
    ["/", "text/html; charset=utf-8"],
    ["/app.js", "text/javascript; charset=utf-8"],
    ["/app.css", "text/css; charset=utf-8"],
  ];
  for (const [pathname, contentType] of expected) {
    const response = await request(daemon.state, {
      path: pathname,
      headers: { Host: host(daemon) },
    });
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers["content-type"], contentType);
    assertCommonHeaders(response, DOCUMENT_CSP);
    assert.equal(response.text.includes(daemon.readToken), false);
    assert.equal(response.text.includes("<script>globalThis.pwned"), false);
    const conditional = await request(daemon.state, {
      path: pathname,
      headers: {
        Host: host(daemon),
        "If-None-Match": '"anything"',
        "If-Modified-Since": new Date().toUTCString(),
      },
    });
    assert.equal(conditional.status, 200);
  }

  for (const pathname of [
    "/index.html",
    "/../../etc/passwd",
    "/%2e%2e%2fetc%2fpasswd",
    "//etc/passwd",
    "/app.js/../app.css",
    "/app.js%00",
    "/APP.JS",
    "/favicon.ico",
  ]) {
    const response = await request(daemon.state, {
      path: pathname,
      headers: { Host: host(daemon) },
    });
    assert.equal(response.status, 404, pathname);
    assert.equal(response.text, "", pathname);
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "d3-static-map-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporary, "index.html"), "shell");
  fs.writeFileSync(path.join(temporary, "app.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(temporary, "app.css"), "body{}\n");
  const assets = loadStaticAssets(temporary);
  fs.rmSync(temporary, { recursive: true, force: true });
  assert.equal(staticAssetFor(assets, "/").body, "shell");
  assert.equal(staticAssetFor(assets, "/not-allowed"), undefined);
});

test("JSON and health responses retain strict data-free security headers", async (t) => {
  const daemon = await oneEventDaemon(t);
  const health = await request(daemon.state, {
    headers: { Host: host(daemon) },
  });
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), [
    "buildVersion",
    "degraded",
    "protocolVersion",
    "ready",
    "schemaVersion",
    "uptimeMs",
  ]);
  assertCommonHeaders(health, JSON_CSP);
  const status = await readRequest(daemon, "/v1/status");
  assertCommonHeaders(status, JSON_CSP);
});

test("tokens rotate on restart and never appear in state, responses, assets, metrics, or logs", async (t) => {
  const agentDir = tempAgentDir(t);
  const first = await startDaemon(t, agentDir);
  const oldReadToken = first.readToken;
  assert.notEqual(oldReadToken, first.token);
  await first.stop();
  const second = await startDaemon(t, agentDir);
  assert.notEqual(second.readToken, oldReadToken);
  const stale = await readRequest(second, "/v1/status", {
    token: oldReadToken,
  });
  assert.equal(stale.status, 401);
  const current = await readRequest(second, "/v1/status");
  assert.equal(current.status, 200);

  for (const file of [
    second.paths.state,
    second.paths.metrics,
    second.paths.log,
  ]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(second.readToken), false, file);
    assert.equal(text.includes(oldReadToken), false, file);
  }
  for (const pathname of ["/", "/app.js", "/app.css", "/v1/status"]) {
    const response = pathname.startsWith("/v1/")
      ? await readRequest(second, pathname)
      : await request(second.state, {
          path: pathname,
          headers: { Host: host(second) },
        });
    assert.equal(response.text.includes(second.readToken), false, pathname);
    assert.equal(response.text.includes(oldReadToken), false, pathname);
  }
});

test("authenticated reads refresh idle activity while health remains activity-neutral", async (t) => {
  const daemon = await startDaemon(t, tempAgentDir(t), ["--idle-ms", "1000"]);
  const reads = setInterval(() => {
    void readRequest(daemon, "/v1/status").catch(() => {});
  }, 100);
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  assert.equal(daemon.child.exitCode, null);
  clearInterval(reads);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("idle exit timed out")),
      4_000,
    );
    daemon.child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  assert.equal(daemon.child.exitCode, 0);
});
