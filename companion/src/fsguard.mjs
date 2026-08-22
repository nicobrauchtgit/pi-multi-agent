import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT } from "./constants.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o777;

export class SecurityError extends Error {
  constructor(reason, file) {
    super(reason);
    this.name = "SecurityError";
    this.code = reason;
    this.exitCode = EXIT.SECURITY;
    this.file = file ? path.basename(file) : undefined;
  }
}

export function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new SecurityError("posix-uid-unavailable");
  }
  return process.getuid();
}

function lstatOrUndefined(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function verifyIdentity(before, after, file) {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new SecurityError("path-changed-during-verification", file);
  }
}

/** Tolerate another trusted starter winning mkdir, then verify what exists. */
function mkdirRaceSafe(file, options) {
  try {
    fs.mkdirSync(file, options);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") {
      throw error;
    }
  }
}

export function secureDirectory(file, options = {}) {
  const uid = currentUid();
  if (!lstatOrUndefined(file)) {
    if (!options.create) throw new SecurityError("directory-missing", file);
    mkdirRaceSafe(file, { mode: DIRECTORY_MODE, recursive: false });
  }
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink())
    throw new SecurityError("symlink-rejected", file);
  if (!before.isDirectory()) throw new SecurityError("not-a-directory", file);
  if (before.uid !== uid) throw new SecurityError("wrong-owner", file);
  const flags =
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY;
  const fd = fs.openSync(file, flags);
  try {
    const opened = fs.fstatSync(fd);
    verifyIdentity(before, opened, file);
    const tightenedMode = before.mode & 0o700;
    if (
      options.tighten !== false &&
      (before.mode & MODE_MASK) !== tightenedMode
    ) {
      // Tightening removes group/other access but must not undo an operator's
      // owner-write lockdown (for example changing 0500 back to 0700).
      fs.fchmodSync(fd, tightenedMode);
    }
    const verified = fs.fstatSync(fd);
    if (
      (verified.mode & MODE_MASK) !==
      (options.tighten === false ? before.mode & MODE_MASK : tightenedMode)
    ) {
      throw new SecurityError("directory-mode-invalid", file);
    }
    if (verified.uid !== uid) throw new SecurityError("wrong-owner", file);
    if (options.rejectWritable && (verified.mode & 0o022) !== 0) {
      throw new SecurityError("insecure-ancestor-mode", file);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function secureFile(file, options = {}) {
  const uid = currentUid();
  const before = lstatOrUndefined(file);
  if (!before) {
    if (options.optional) return false;
    throw new SecurityError("file-missing", file);
  }
  if (before.isSymbolicLink())
    throw new SecurityError("symlink-rejected", file);
  if (!before.isFile()) throw new SecurityError("not-a-file", file);
  if (before.uid !== uid) throw new SecurityError("wrong-owner", file);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    verifyIdentity(before, opened, file);
    fs.fchmodSync(fd, FILE_MODE);
    const verified = fs.fstatSync(fd);
    if ((verified.mode & MODE_MASK) !== FILE_MODE) {
      throw new SecurityError("file-mode-invalid", file);
    }
    if (verified.uid !== uid) throw new SecurityError("wrong-owner", file);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function openProtectedFile(file, maximum) {
  const uid = currentUid();
  const before = lstatOrUndefined(file);
  if (!before) throw new SecurityError("file-missing", file);
  if (before.isSymbolicLink())
    throw new SecurityError("symlink-rejected", file);
  if (!before.isFile()) throw new SecurityError("not-a-file", file);
  if (before.uid !== uid) throw new SecurityError("wrong-owner", file);
  if (before.size > maximum) throw new SecurityError("file-too-large", file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    verifyIdentity(before, opened, file);
    fs.fchmodSync(fd, FILE_MODE);
    const verified = fs.fstatSync(fd);
    if (
      verified.uid !== uid ||
      (verified.mode & MODE_MASK) !== FILE_MODE ||
      verified.size > maximum
    ) {
      throw new SecurityError("file-security-invalid", file);
    }
    return { fd, identity: fileIdentity(verified) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function inspectProtectedFile(file, maximum = Number.MAX_SAFE_INTEGER) {
  const opened = openProtectedFile(file, maximum);
  fs.closeSync(opened.fd);
  return opened.identity;
}

/** Read one stable regular file through the descriptor that was verified. */
export function readStableProtectedFile(file, maximum) {
  const opened = openProtectedFile(file, maximum);
  try {
    const bytes = fs.readFileSync(opened.fd);
    const after = fs.fstatSync(opened.fd);
    if (
      bytes.length !== opened.identity.size ||
      !sameFileIdentity(opened.identity, fileIdentity(after))
    ) {
      throw new SecurityError("file-changed-during-read", file);
    }
    return { bytes, identity: opened.identity };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function pathMatchesProtectedIdentity(file, identity) {
  const current = lstatOrUndefined(file);
  return Boolean(
    current &&
    current.isFile() &&
    sameFileIdentity(identity, fileIdentity(current)),
  );
}

export function unlinkProtectedFile(file, identity) {
  if (!pathMatchesProtectedIdentity(file, identity)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return Boolean(
      error && typeof error === "object" && error.code === "ENOENT",
    );
  }
}

/** Create and verify the protected tree without following an existing link. */
export function ensureCompanionTree(paths) {
  const agentBefore = lstatOrUndefined(paths.agentDir);
  if (!agentBefore)
    mkdirRaceSafe(paths.agentDir, { mode: DIRECTORY_MODE, recursive: true });
  secureDirectory(paths.agentDir, { tighten: false, rejectWritable: true });

  if (!lstatOrUndefined(paths.multiAgentDir)) {
    mkdirRaceSafe(paths.multiAgentDir, {
      mode: DIRECTORY_MODE,
      recursive: false,
    });
  }
  secureDirectory(paths.multiAgentDir, {
    tighten: false,
    rejectWritable: true,
  });

  for (const directory of [
    paths.root,
    paths.spoolDir,
    paths.quarantineDir,
    paths.logsDir,
  ]) {
    secureDirectory(directory, { create: true, tighten: true });
  }
  for (const file of [
    paths.lock,
    paths.state,
    paths.config,
    paths.spoolState,
    paths.ingestToken,
    paths.readToken,
    paths.metrics,
    paths.database,
    paths.wal,
    paths.shm,
    paths.log,
  ]) {
    secureFile(file, { optional: true });
  }
}

export function verifyDatabaseFiles(paths) {
  secureFile(paths.database);
  secureFile(paths.wal, { optional: true });
  secureFile(paths.shm, { optional: true });
}

export function assertNoSymlink(file) {
  const stat = lstatOrUndefined(file);
  if (stat?.isSymbolicLink()) throw new SecurityError("symlink-rejected", file);
  return stat;
}
