import assert from "node:assert/strict";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { observabilityPaths } from "../shared/observability/home.mjs";
import {
  createDaemonController,
  openObservabilityUi,
} from "./src/daemon-control.ts";

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

function health(port: number) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        headers: { Host: `127.0.0.1:${port}` },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("concurrent lazy cold starts coalesce and reuse exactly one temp daemon", async (t) => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-daemon-control-d2-"),
  );
  fs.chmodSync(agentDir, 0o700);
  const paths = observabilityPaths(agentDir);
  let daemonPid: number | undefined;
  t.after(async () => {
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // Already idle/stopped.
      }
    }
    await waitFor(
      () => (!fs.existsSync(paths.state) ? true : undefined),
      5_000,
    ).catch(() => undefined);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  const transitions: string[] = [];
  const controller = createDaemonController({
    paths,
    autostart: true,
    onTransition: (state, reason) => transitions.push(`${state}:${reason}`),
  });
  const results = await Promise.all(
    Array.from({ length: 12 }, () => controller.ensureDaemon()),
  );
  assert.ok(results.every(Boolean));
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  daemonPid = state.pid;
  assert.equal(await health(state.port), 200);
  assert.equal(controller.state.health, "healthy");
  const uiUrl = await controller.readUiUrl();
  const parsedUiUrl = new URL(uiUrl);
  assert.equal(parsedUiUrl.hostname, "127.0.0.1");
  assert.equal(parsedUiUrl.port, String(state.port));
  assert.match(parsedUiUrl.hash, /^#[A-Za-z0-9_-]{43}$/);
  assert.equal(
    fs.readFileSync(paths.state, "utf8").includes(parsedUiUrl.hash.slice(1)),
    false,
  );
  assert.equal(
    transitions.filter((entry) => entry.startsWith("starting")).length,
    1,
  );

  const second = createDaemonController({ paths, autostart: true });
  assert.equal(await second.ensureDaemon(), true);
  assert.equal(JSON.parse(fs.readFileSync(paths.state, "utf8")).pid, daemonPid);
});

test("browser opener receives the fragment only as one argv value and returns no URL", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let unrefCalled = false;
  const spawnProcess = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {
      unrefCalled = true;
    };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as never;
  const token = "a".repeat(43);
  const result = await openObservabilityUi(`http://127.0.0.1:1234/#${token}`, {
    platform: "darwin",
    spawnProcess,
  });
  assert.equal(result, undefined);
  assert.deepEqual(calls, [
    { command: "open", args: [`http://127.0.0.1:1234/#${token}`] },
  ]);
  assert.equal(unrefCalled, true);
  await assert.rejects(
    openObservabilityUi(`http://localhost:1234/#${token}`, { spawnProcess }),
    /invalid-observability-url/,
  );
});

test("exit 69 becomes permanent spool-only without a respawn loop", async (t) => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-daemon-unavailable-d2-"),
  );
  fs.chmodSync(agentDir, 0o700);
  const entry = path.join(agentDir, "unavailable.mjs");
  fs.writeFileSync(entry, "process.exit(69);\n", { mode: 0o600 });
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const controller = createDaemonController({
    paths: observabilityPaths(agentDir),
    autostart: true,
    daemonEntry: entry,
    startupBudgetMs: 500,
  });
  assert.equal(await controller.ensureDaemon(), false);
  assert.equal(controller.state.permanentUnavailable, true);
  assert.equal(controller.state.health, "unavailable");
  const started = Date.now();
  assert.equal(await controller.ensureDaemon(), false);
  assert.ok(Date.now() - started < 100);
});
