import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ObservabilityPaths } from "../../shared/observability/home.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MODE_MASK = 0o777;

export interface ProtectedFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export class ProtectedFileError extends Error {
  readonly code: string;
  readonly file?: string;

  constructor(code: string, file?: string) {
    super(code);
    this.name = "ProtectedFileError";
    this.code = code;
    this.file = file ? path.basename(file) : undefined;
  }
}

function uid() {
  if (typeof process.getuid !== "function") {
    throw new ProtectedFileError("posix-uid-unavailable");
  }
  return process.getuid();
}

function lstat(file: string) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function mkdirRaceSafe(file: string, recursive = false) {
  try {
    fs.mkdirSync(file, { recursive, mode: DIRECTORY_MODE });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

export function secureDirectory(
  file: string,
  options: {
    create?: boolean;
    tighten?: boolean;
    rejectWritable?: boolean;
  } = {},
) {
  if (!lstat(file)) {
    if (!options.create)
      throw new ProtectedFileError("directory-missing", file);
    mkdirRaceSafe(file);
  }
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink())
    throw new ProtectedFileError("symlink-rejected", file);
  if (!before.isDirectory())
    throw new ProtectedFileError("not-a-directory", file);
  if (before.uid !== uid()) throw new ProtectedFileError("wrong-owner", file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
  );
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ProtectedFileError("path-changed-during-verification", file);
    }
    const tightenedMode = before.mode & 0o700;
    if (
      options.tighten !== false &&
      (before.mode & MODE_MASK) !== tightenedMode
    ) {
      // Remove group/other access, but never add owner write permission back
      // to an operator-imposed read-only lockdown (for example 0500).
      fs.fchmodSync(fd, tightenedMode);
    }
    const verified = fs.fstatSync(fd);
    if (verified.uid !== uid())
      throw new ProtectedFileError("wrong-owner", file);
    if (
      options.tighten !== false &&
      (verified.mode & MODE_MASK) !== tightenedMode
    ) {
      throw new ProtectedFileError("directory-mode-invalid", file);
    }
    if (options.rejectWritable && (verified.mode & 0o022) !== 0) {
      throw new ProtectedFileError("insecure-ancestor-mode", file);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function secureFile(file: string, optional = false) {
  const before = lstat(file);
  if (!before) {
    if (optional) return false;
    throw new ProtectedFileError("file-missing", file);
  }
  if (before.isSymbolicLink())
    throw new ProtectedFileError("symlink-rejected", file);
  if (!before.isFile()) throw new ProtectedFileError("not-a-file", file);
  if (before.uid !== uid()) throw new ProtectedFileError("wrong-owner", file);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ProtectedFileError("path-changed-during-verification", file);
    }
    fs.fchmodSync(fd, FILE_MODE);
    const verified = fs.fstatSync(fd);
    if (verified.uid !== uid() || (verified.mode & MODE_MASK) !== FILE_MODE) {
      throw new ProtectedFileError("file-security-invalid", file);
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function ensureProducerTree(paths: ObservabilityPaths) {
  if (!lstat(paths.agentDir)) mkdirRaceSafe(paths.agentDir, true);
  secureDirectory(paths.agentDir, { tighten: false, rejectWritable: true });
  if (!lstat(paths.multiAgentDir)) mkdirRaceSafe(paths.multiAgentDir);
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
    secureDirectory(directory, { create: true });
  }
  for (const file of [
    paths.config,
    paths.spoolState,
    paths.state,
    paths.ingestToken,
    paths.readToken,
    paths.metrics,
    paths.database,
    paths.wal,
    paths.shm,
    paths.lock,
    paths.log,
  ]) {
    secureFile(file, true);
  }
}

function fileIdentity(stat: fs.Stats): ProtectedFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameFileIdentity(
  left: ProtectedFileIdentity,
  right: ProtectedFileIdentity,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function openProtectedFile(file: string, maxBytes: number) {
  const before = lstat(file);
  if (!before) throw new ProtectedFileError("file-missing", file);
  if (before.isSymbolicLink())
    throw new ProtectedFileError("symlink-rejected", file);
  if (!before.isFile()) throw new ProtectedFileError("not-a-file", file);
  if (before.uid !== uid()) throw new ProtectedFileError("wrong-owner", file);
  if (before.size > maxBytes)
    throw new ProtectedFileError("file-too-large", file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== uid()
    ) {
      throw new ProtectedFileError("protected-file-changed", file);
    }
    fs.fchmodSync(fd, FILE_MODE);
    const verified = fs.fstatSync(fd);
    if (
      verified.uid !== uid() ||
      (verified.mode & MODE_MASK) !== FILE_MODE ||
      verified.size > maxBytes
    ) {
      throw new ProtectedFileError("file-security-invalid", file);
    }
    return { fd, identity: fileIdentity(verified) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function inspectProtectedFile(
  file: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
) {
  const opened = openProtectedFile(file, maxBytes);
  fs.closeSync(opened.fd);
  return opened.identity;
}

export function readStableProtectedFile(
  file: string,
  maxBytes = 64 * 1024,
): { bytes: Buffer; identity: ProtectedFileIdentity } {
  const opened = openProtectedFile(file, maxBytes);
  try {
    const bytes = fs.readFileSync(opened.fd);
    const after = fs.fstatSync(opened.fd);
    if (
      bytes.length !== opened.identity.size ||
      !sameFileIdentity(opened.identity, fileIdentity(after))
    ) {
      throw new ProtectedFileError("protected-file-changed", file);
    }
    return { bytes, identity: opened.identity };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function pathMatchesProtectedIdentity(
  file: string,
  identity: ProtectedFileIdentity,
) {
  const current = lstat(file);
  return Boolean(
    current &&
    current.isFile() &&
    sameFileIdentity(identity, fileIdentity(current)),
  );
}

export function unlinkProtectedFile(
  file: string,
  identity: ProtectedFileIdentity,
) {
  if (!pathMatchesProtectedIdentity(file, identity)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
    );
  }
}

export function readProtectedText(file: string, maxBytes = 64 * 1024) {
  return readStableProtectedFile(file, maxBytes).bytes.toString("utf8");
}

export function readProtectedJson(file: string, maxBytes = 64 * 1024): unknown {
  return JSON.parse(readProtectedText(file, maxBytes));
}

export function writeAtomicProtectedFile(file: string, value: string) {
  const existing = lstat(file);
  if (existing?.isSymbolicLink())
    throw new ProtectedFileError("symlink-rejected", file);
  const directory = path.dirname(file);
  secureDirectory(directory, { tighten: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", FILE_MODE);
    fs.writeFileSync(fd, value, "utf8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, FILE_MODE);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    secureFile(file);
    const directoryFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the primary write error.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A crash-stale temp is recovered by the spool scanner.
    }
    throw error;
  }
}

export function writeAtomicProtectedJson(file: string, value: unknown) {
  writeAtomicProtectedFile(file, `${JSON.stringify(value)}\n`);
}
