import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { BUILD_VERSION, EXIT, PROTOCOL_VERSION } from "./constants.mjs";
import { secureFile } from "./fsguard.mjs";
import { removeMatchingState } from "./state.mjs";

export const TORN_LOCK_STALE_MS = 30_000;

export class LockHeldError extends Error {
  constructor(owner) {
    super("daemon-lock-held");
    this.name = "LockHeldError";
    this.code = "daemon-lock-held";
    this.exitCode = EXIT.LOCKED;
    this.owner = owner;
  }
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error && typeof error === "object" && error.code === "EPERM",
    );
  }
}

export function validLockRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.hostname === "string" &&
    typeof value.startToken === "string" &&
    value.startToken.length >= 16 &&
    Number.isFinite(value.startedAt),
  );
}

function readLockSnapshot(file) {
  secureFile(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    let record;
    if (stat.size <= 64 * 1024) {
      try {
        const value = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (validLockRecord(value)) record = value;
      } catch {
        // A bounded invalid record is a torn lock, not a trusted owner.
      }
    }
    return {
      record,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readLock(file) {
  try {
    return readLockSnapshot(file).record;
  } catch {
    return undefined;
  }
}

function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeLockSnapshot(file, expected, requireToken = true) {
  try {
    const current = readLockSnapshot(file);
    if (!sameSnapshot(current, expected)) return false;
    if (
      requireToken &&
      expected.record?.startToken &&
      current.record?.startToken !== expected.record.startToken
    ) {
      return false;
    }
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return Boolean(
      error && typeof error === "object" && error.code === "ENOENT",
    );
  }
}

function createLockFile(file, record) {
  let fd;
  let created;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    const stat = fs.fstatSync(fd);
    created = { record, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    secureFile(file);
    const verified = readLockSnapshot(file);
    if (
      !sameSnapshot(verified, created) ||
      verified.record?.startToken !== record.startToken
    ) {
      throw new LockHeldError(verified.record);
    }
    return created;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the lock-creation error.
      }
    }
    if (created) removeLockSnapshot(file, created, false);
    throw error;
  }
}

export function acquireDaemonLock(paths, options = {}) {
  const hostname = options.hostname ?? os.hostname();
  const now = options.now ?? Date.now();
  const startToken =
    options.startToken ?? crypto.randomBytes(24).toString("base64url");
  const record = {
    version: 1,
    pid: process.pid,
    hostname,
    startToken,
    startedAt: now,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: BUILD_VERSION,
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const created = createLockFile(paths.lock, record);
      let released = false;
      return {
        record,
        release() {
          if (released) return true;
          released = true;
          return removeLockSnapshot(paths.lock, created);
        },
      };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }

      let observed;
      try {
        observed = readLockSnapshot(paths.lock);
      } catch (readError) {
        if (
          readError &&
          typeof readError === "object" &&
          (readError.code === "ENOENT" || readError.code === "file-missing")
        ) {
          continue;
        }
        throw readError;
      }
      const owner = observed.record;
      const stale = owner
        ? owner.hostname === hostname && !processIsAlive(owner.pid)
        : now - observed.mtimeMs > (options.staleMs ?? TORN_LOCK_STALE_MS);
      if (!stale) throw new LockHeldError(owner);

      options.beforeStaleUnlink?.({ owner });
      if (!removeLockSnapshot(paths.lock, observed)) continue;
      if (owner?.startToken) removeMatchingState(paths.state, owner.startToken);
    }
  }
  throw new LockHeldError(readLock(paths.lock));
}
