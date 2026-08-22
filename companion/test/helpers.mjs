import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { homePaths } from "../src/home.mjs";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const daemonEntry = path.join(repositoryRoot, "companion", "daemon.mjs");

export function tempAgentDir(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-observability-d1-"),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function event(overrides = {}) {
  const base = {
    v: 1,
    eventId: "event-opaque-1",
    kind: "workflow.started",
    schemaVersion: 1,
    producer: { id: "producer-opaque", seq: 1, kind: "pi" },
    occurredAt: 1_000,
    ids: {
      traceId: "pi-session:test",
      runId: "wf_abcdef123456",
      parentRunId: "pi-run:test",
    },
    project: { id: "supplied", root: "/tmp/project" },
    payload: { name: "test workflow", background: false, phaseCount: 1 },
    capture: { contentMode: "rich", truncated: false },
  };
  return {
    ...base,
    ...overrides,
    producer: { ...base.producer, ...(overrides.producer ?? {}) },
    ids: { ...base.ids, ...(overrides.ids ?? {}) },
    payload: { ...base.payload, ...(overrides.payload ?? {}) },
    capture: { ...base.capture, ...(overrides.capture ?? {}) },
    ...(overrides.project === null ? { project: undefined } : {}),
  };
}

export async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

export async function startDaemon(t, agentDir, extra = []) {
  const child = spawn(
    process.execPath,
    [
      daemonEntry,
      "start",
      "--agent-dir",
      agentDir,
      "--idle-ms",
      "60000",
      ...extra,
    ],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const paths = homePaths(agentDir);
  const state = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(paths.state, "utf8"));
    } catch {
      if (child.exitCode !== null)
        throw new Error(`daemon exited ${child.exitCode}: ${stderr}`);
      return null;
    }
  });
  const token = fs.readFileSync(paths.ingestToken, "utf8").trim();
  const readToken = fs.readFileSync(paths.readToken, "utf8").trim();
  const stop = async (signal = "SIGTERM") => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("daemon did not stop")), 5_000),
      ),
    ]);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await stop();
  });
  return {
    child,
    paths,
    state,
    token,
    readToken,
    stop,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export function request(state, options = {}) {
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers ?? {}) };
    if (body !== undefined && options.contentLength !== false) {
      headers["Content-Length"] =
        typeof options.contentLength === "number"
          ? options.contentLength
          : Buffer.byteLength(body);
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port: state.port,
        method: options.method ?? "GET",
        path: options.path ?? "/healthz",
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export function readRequest(daemon, path, overrides = {}) {
  return request(daemon.state, {
    method: overrides.method ?? "GET",
    path,
    headers: {
      Host: `127.0.0.1:${daemon.state.port}`,
      Authorization: `Bearer ${overrides.token ?? daemon.readToken}`,
      ...(overrides.headers ?? {}),
    },
    ...(overrides.body === undefined ? {} : { body: overrides.body }),
  });
}

export async function ingest(daemon, events, overrides = {}) {
  return request(daemon.state, {
    method: "POST",
    path: "/v1/ingest",
    headers: {
      Host: `127.0.0.1:${daemon.state.port}`,
      Authorization: `Bearer ${daemon.token}`,
      "Content-Type": "application/json",
      ...(overrides.headers ?? {}),
    },
    body: overrides.body ?? { v: 1, events },
  });
}

export function assertMode(file, expected) {
  assert.equal(fs.statSync(file).mode & 0o777, expected, file);
}
