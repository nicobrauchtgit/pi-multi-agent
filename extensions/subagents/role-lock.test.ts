import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { acquireRoleLock, getRoleLocksDir } from "./src/role-lock.ts";

test("role lock is exclusive and can be reacquired after release", () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagent-role-lock-"),
  );
  try {
    const first = acquireRoleLock("reviewer", agentDir);
    assert.throws(
      () => acquireRoleLock("reviewer", agentDir),
      /already active.*PID/,
    );
    first.release();
    const second = acquireRoleLock("reviewer", agentDir);
    second.release();
    assert.deepEqual(fs.readdirSync(getRoleLocksDir(agentDir)), []);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("role lock release is idempotent", () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagent-role-lock-"),
  );
  try {
    const lock = acquireRoleLock("researcher", agentDir);
    lock.release();
    lock.release();
    assert.deepEqual(fs.readdirSync(getRoleLocksDir(agentDir)), []);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an old corrupt role lock is reclaimed", () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagent-role-lock-"),
  );
  try {
    const dir = getRoleLocksDir(agentDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${Buffer.from("stale-role").toString("base64url")}.lock`,
    );
    fs.writeFileSync(file, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);

    const lock = acquireRoleLock("stale-role", agentDir);
    lock.release();
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
