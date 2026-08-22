import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase, checkpointAndClose } from "../src/db/open.mjs";
import { userVersion } from "../src/db/migrate.mjs";
import { SCHEMA_V1_SQL } from "../src/db/schema-v1.mjs";
import {
  ensureCompanionTree,
  readStableProtectedFile,
  unlinkProtectedFile,
  verifyDatabaseFiles,
} from "../src/fsguard.mjs";
import { homePaths } from "../src/home.mjs";
import { acquireDaemonLock, LockHeldError } from "../src/lock.mjs";
import { assertGoldenSchema, quickCheckDatabase } from "../src/maintenance.mjs";
import { cleanupAtomicTemps } from "../src/state.mjs";
import { assertMode, tempAgentDir } from "./helpers.mjs";

test("protected home rejects symlinks and writable ancestors", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  fs.mkdirSync(paths.multiAgentDir, { mode: 0o700 });
  const target = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-observability-target-"),
  );
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.symlinkSync(target, paths.root, "dir");
  assert.throws(
    () => ensureCompanionTree(paths),
    (error) => error.code === "symlink-rejected" && error.exitCode === 71,
  );
  fs.unlinkSync(paths.root);

  fs.chmodSync(agentDir, 0o777);
  assert.throws(
    () => ensureCompanionTree(paths),
    (error) => error.code === "insecure-ancestor-mode",
  );
});

test("directory tightening preserves an operator owner-write lockdown", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  fs.chmodSync(paths.root, 0o500);
  ensureCompanionTree(paths);
  assertMode(paths.root, 0o500);
  fs.chmodSync(paths.root, 0o700);
});

test("protected files and SQLite sidecars are tightened to 0600", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  fs.writeFileSync(paths.ingestToken, "placeholder\n", { mode: 0o644 });
  ensureCompanionTree(paths);
  assertMode(paths.root, 0o700);
  assertMode(paths.spoolDir, 0o700);
  assertMode(paths.logsDir, 0o700);
  assertMode(paths.ingestToken, 0o600);

  const opened = openDatabase(paths.database);
  verifyDatabaseFiles(paths);
  assertMode(paths.database, 0o600);
  if (fs.existsSync(paths.wal)) assertMode(paths.wal, 0o600);
  if (fs.existsSync(paths.shm)) assertMode(paths.shm, 0o600);
  checkpointAndClose(opened.db);
});

test("stable companion reads never delete a replacement path", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const file = path.join(paths.spoolDir, "stable-read-test");
  const moved = `${file}.moved`;
  fs.writeFileSync(file, "original\n", { mode: 0o600 });
  const stable = readStableProtectedFile(file, 1024);
  fs.renameSync(file, moved);
  fs.writeFileSync(file, "replacement\n", { mode: 0o600 });
  assert.equal(unlinkProtectedFile(file, stable.identity), false);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement\n");
  assert.equal(stable.bytes.toString("utf8"), "original\n");
});

test("concurrent cold-start tree creation is race-safe", async (t) => {
  const agentDir = tempAgentDir(t);
  const guardUrl = new URL("../src/fsguard.mjs", import.meta.url).href;
  const homeUrl = new URL("../src/home.mjs", import.meta.url).href;
  const worker = `
    import { ensureCompanionTree } from ${JSON.stringify(guardUrl)};
    import { homePaths } from ${JSON.stringify(homeUrl)};
    const [agentDir, startText] = process.argv.slice(1);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < Number(startText)) Atomics.wait(wait, 0, 0, 2);
    ensureCompanionTree(homePaths(agentDir));
    process.stdout.write("ready\\n");
  `;
  const startAt = Date.now() + 100;
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", worker, agentDir, String(startAt)],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.setEncoding("utf8").on("data", (chunk) => {
            stderr += chunk;
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve(stdout);
            else
              reject(new Error(`cold-start worker exited ${code}: ${stderr}`));
          });
        }),
    ),
  );
  assert.deepEqual(
    results,
    Array.from({ length: 8 }, () => "ready\n"),
  );
  const paths = homePaths(agentDir);
  assertMode(paths.root, 0o700);
  assertMode(paths.spoolDir, 0o700);
  assertMode(paths.logsDir, 0o700);
});

test("daemon lock is exclusive, token checked, and reclaims a dead local PID", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const first = acquireDaemonLock(paths, {
    startToken: "first-start-token-0001",
  });
  assert.throws(() => acquireDaemonLock(paths), LockHeldError);

  const successor = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    startToken: "successor-token-0002",
    startedAt: Date.now(),
  };
  fs.writeFileSync(paths.lock, `${JSON.stringify(successor)}\n`, {
    mode: 0o600,
  });
  assert.equal(first.release(), false);
  assert.equal(fs.existsSync(paths.lock), true);

  fs.writeFileSync(
    paths.lock,
    `${JSON.stringify({ ...successor, pid: 999_999_999, startToken: "dead-start-token-0003" })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    paths.state,
    `${JSON.stringify({ startToken: "dead-start-token-0003" })}\n`,
    { mode: 0o600 },
  );
  const reclaimed = acquireDaemonLock(paths, {
    startToken: "reclaimed-token-0004",
  });
  assert.equal(
    JSON.parse(fs.readFileSync(paths.lock, "utf8")).startToken,
    "reclaimed-token-0004",
  );
  assert.equal(fs.existsSync(paths.state), false);
  assert.equal(reclaimed.release(), true);
  assert.equal(fs.existsSync(paths.lock), false);
});

test("stale reclaim cannot unlink a successor lock installed after observation", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const stale = {
    version: 1,
    pid: 999_999_999,
    hostname: os.hostname(),
    startToken: "stale-observed-token-0001",
    startedAt: 1,
  };
  const successor = {
    ...stale,
    pid: process.pid,
    startToken: "live-successor-token-0002",
    startedAt: Date.now(),
  };
  fs.writeFileSync(paths.lock, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  assert.throws(
    () =>
      acquireDaemonLock(paths, {
        beforeStaleUnlink() {
          fs.unlinkSync(paths.lock);
          fs.writeFileSync(paths.lock, `${JSON.stringify(successor)}\n`, {
            mode: 0o600,
          });
        },
      }),
    LockHeldError,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(paths.lock, "utf8")).startToken,
    successor.startToken,
  );
});

test("concurrent stale-lock reclaim has exactly one live winner", async (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  fs.writeFileSync(
    paths.lock,
    `${JSON.stringify({
      version: 1,
      pid: 999_999_999,
      hostname: os.hostname(),
      startToken: "concurrent-dead-token-0001",
      startedAt: 1,
    })}\n`,
    { mode: 0o600 },
  );
  const lockUrl = new URL("../src/lock.mjs", import.meta.url).href;
  const homeUrl = new URL("../src/home.mjs", import.meta.url).href;
  const worker = `
    import { acquireDaemonLock, LockHeldError } from ${JSON.stringify(lockUrl)};
    import { homePaths } from ${JSON.stringify(homeUrl)};
    const [agentDir, startText] = process.argv.slice(1);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < Number(startText)) Atomics.wait(wait, 0, 0, 2);
    try {
      const lock = acquireDaemonLock(homePaths(agentDir));
      process.stdout.write("winner\\n");
      Atomics.wait(wait, 0, 0, 300);
      lock.release();
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error;
    }
  `;
  const startAt = Date.now() + 100;
  const outputs = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", worker, agentDir, String(startAt)],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`lock worker exited ${code}: ${stderr}`));
          });
        }),
    ),
  );
  assert.equal(outputs.filter((output) => output.includes("winner")).length, 1);
});

test("foreign-host locks are never stolen and conservatively stale torn locks recover", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  fs.writeFileSync(
    paths.lock,
    `${JSON.stringify({
      version: 1,
      pid: 999_999_999,
      hostname: "different-host.invalid",
      startToken: "foreign-start-token-0001",
      startedAt: 1,
    })}\n`,
    { mode: 0o600 },
  );
  assert.throws(() => acquireDaemonLock(paths), LockHeldError);
  fs.writeFileSync(paths.lock, "", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.lock, old, old);
  const recovered = acquireDaemonLock(paths, { staleMs: 30_000 });
  assert.equal(recovered.release(), true);
});

test("orphaned atomic state temps are secured and removed by the next lock owner", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const orphan = path.join(
    paths.root,
    ".daemon.json.999999.0123456789abcdef.tmp",
  );
  const unrelated = path.join(paths.root, ".operator-note.tmp");
  fs.writeFileSync(orphan, "protected state", { mode: 0o644 });
  fs.writeFileSync(unrelated, "keep", { mode: 0o600 });
  cleanupAtomicTemps(paths.root);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(unrelated), true);
});

test("migration v1 is fresh, repeatable, WAL-backed, strict, and exactly three application tables", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  let opened = openDatabase(paths.database);
  assert.equal(opened.version, 1);
  assert.equal(opened.journalMode.toLowerCase(), "wal");
  assert.equal(opened.autoVacuum, 2);
  assert.equal(userVersion(opened.db), 1);
  assertGoldenSchema(opened.db);
  quickCheckDatabase(opened.db);
  const tables = opened.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["agents", "events", "runs"]);
  checkpointAndClose(opened.db);

  opened = openDatabase(paths.database);
  assert.equal(opened.version, 1);
  assertGoldenSchema(opened.db);
  checkpointAndClose(opened.db);
});

test("migration failure rolls back DDL and leaves the database file intact", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  assert.throws(
    () => openDatabase(paths.database, { injectFailureAt: 1 }),
    (error) => error.code === "migration-failed" && error.exitCode === 73,
  );
  assert.equal(fs.existsSync(paths.database), true);
  const db = new DatabaseSync(paths.database);
  assert.equal(userVersion(db), 0);
  const applicationTables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  assert.deepEqual(applicationTables, []);
  db.close();
});

test("newer schema is refused without rewriting or deleting the database", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const opened = openDatabase(paths.database);
  checkpointAndClose(opened.db);
  const fixture = new DatabaseSync(paths.database);
  fixture.exec("PRAGMA user_version = 2");
  fixture.close();
  const before = fs.readFileSync(paths.database);
  assert.throws(
    () => openDatabase(paths.database),
    (error) =>
      error.code === "schema-newer-than-binary" && error.exitCode === 73,
  );
  assert.deepEqual(fs.readFileSync(paths.database), before);
});

test("WAL restart after SIGKILL rolls back an in-flight event and projection together", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const opened = openDatabase(paths.database);
  checkpointAndClose(opened.db);

  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    db.exec(\`INSERT INTO events (
      event_id,envelope_version,event_kind,schema_version,producer_id,producer_seq,
      producer_kind,received_at_ms,payload_json,redaction_json,payload_sha256
    ) VALUES ('crash-event',1,'workflow.started',1,'crash-producer',1,'pi',1,'{}','{}','hash')\`);
    db.exec(\`INSERT INTO runs (
      run_id,run_kind,status,recovered_from_artifact,content_mode,last_seq,metadata_json
    ) VALUES ('wf_crash000000','workflow','running',0,'rich',1,'{}')\`);
    process.kill(process.pid, "SIGKILL");
  `;
  const killed = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    paths.database,
  ]);
  assert.equal(killed.signal, "SIGKILL");

  const recovered = openDatabase(paths.database);
  assert.equal(
    recovered.db.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    0,
  );
  assert.equal(
    recovered.db.prepare("SELECT COUNT(*) AS count FROM runs").get().count,
    0,
  );
  quickCheckDatabase(recovered.db);
  checkpointAndClose(recovered.db);
});

test("golden quick check detects complete table constraint drift", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const db = new DatabaseSync(paths.database);
  db.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;");
  db.exec(
    SCHEMA_V1_SQL.replace(
      "  status                TEXT NOT NULL,\n  started_at_ms",
      "  status                TEXT,\n  started_at_ms",
    ),
  );
  db.exec("PRAGMA user_version=1");
  assert.throws(
    () => quickCheckDatabase(db),
    (error) =>
      error.code === "schema-definition-drift" && error.exitCode === 74,
  );
  db.close();
});

test("golden quick check detects dropped indexes", (t) => {
  const agentDir = tempAgentDir(t);
  const paths = homePaths(agentDir);
  ensureCompanionTree(paths);
  const opened = openDatabase(paths.database);
  opened.db.exec("DROP INDEX events_tool_call_seq");
  assert.throws(
    () => quickCheckDatabase(opened.db),
    (error) => error.code === "index-drift" && error.exitCode === 74,
  );
  opened.db.close();
});
