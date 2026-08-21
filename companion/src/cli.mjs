import * as fs from "node:fs";
import { EXIT } from "./constants.mjs";
import { runDaemon, reuseRunningDaemon } from "./daemon-runtime.mjs";
import { ensureCompanionTree, secureDirectory } from "./fsguard.mjs";
import { homePaths, resolveAgentDir } from "./home.mjs";
import { acquireDaemonLock, LockHeldError } from "./lock.mjs";
import { quickCheckFile, status } from "./maintenance.mjs";
import { checkpointAndClose, openDatabase } from "./db/open.mjs";
import { quickCheckDatabase } from "./maintenance.mjs";
import { rebuildProjections } from "./project/rebuild.mjs";
import { cleanupAtomicTemps } from "./state.mjs";

function parseArguments(argv) {
  let command = "start";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    index = 1;
  }
  const options = { check: false, json: false };
  while (index < argv.length) {
    const argument = argv[index++];
    if (argument === "--check") options.check = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--agent-dir") {
      const value = argv[index++];
      if (!value)
        throw Object.assign(new Error("missing-agent-dir"), {
          code: "missing-agent-dir",
          exitCode: EXIT.USAGE,
        });
      options.agentDir = value;
    } else if (argument === "--idle-ms") {
      options.idleMs = Number(argv[index++]);
    } else
      throw Object.assign(new Error("invalid-argument"), {
        code: "invalid-argument",
        exitCode: EXIT.USAGE,
      });
  }
  if (options.agentDir === undefined) options.agentDir = resolveAgentDir();
  if (
    options.idleMs !== undefined &&
    (!Number.isFinite(options.idleMs) || options.idleMs < 1_000)
  ) {
    throw Object.assign(new Error("invalid-idle-ms"), {
      code: "invalid-idle-ms",
      exitCode: EXIT.USAGE,
    });
  }
  return { command, options };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function ensureExistingTree(paths) {
  if (!fs.existsSync(paths.root))
    throw Object.assign(new Error("companion-home-missing"), {
      code: "companion-home-missing",
      exitCode: EXIT.CORRUPT,
    });
  ensureCompanionTree(paths);
}

async function start(paths, options) {
  ensureCompanionTree(paths);
  let lock;
  try {
    lock = acquireDaemonLock(paths);
  } catch (error) {
    if (error instanceof LockHeldError && (await reuseRunningDaemon(paths))) {
      output({ ok: true, code: "reused" });
      return;
    }
    throw error;
  }
  await runDaemon(paths, lock, options);
}

function runStatus(paths) {
  if (fs.existsSync(paths.root)) ensureCompanionTree(paths);
  output({ ok: true, status: status(paths) });
}

function runQuickCheck(paths) {
  ensureExistingTree(paths);
  output(quickCheckFile(paths));
}

function runRebuild(paths, options) {
  ensureExistingTree(paths);
  if (!fs.existsSync(paths.database)) {
    throw Object.assign(new Error("database-missing"), {
      code: "database-missing",
      exitCode: EXIT.CORRUPT,
    });
  }
  const lock = acquireDaemonLock(paths);
  let opened;
  try {
    cleanupAtomicTemps(paths.root);
    opened = openDatabase(paths.database);
    quickCheckDatabase(opened.db);
    const result = rebuildProjections(opened.db, { check: options.check });
    checkpointAndClose(opened.db);
    opened = undefined;
    output({ ok: true, ...result });
  } finally {
    if (opened?.db) opened.db.close();
    lock.release();
  }
}

export async function runCli(argv) {
  const { command, options } = parseArguments(argv);
  const paths = homePaths(options.agentDir);
  if (command === "start") return start(paths, options);
  if (command === "status") return runStatus(paths);
  if (command === "quick-check") return runQuickCheck(paths);
  if (command === "rebuild") return runRebuild(paths, options);
  throw Object.assign(new Error("unknown-command"), {
    code: "unknown-command",
    exitCode: EXIT.USAGE,
  });
}
