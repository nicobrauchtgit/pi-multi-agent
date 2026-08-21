import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertNoSymlink, secureFile } from "./fsguard.mjs";

const ATOMIC_STATE_FILES = new Set([
  "daemon.json",
  "daemon-metrics.json",
  "ingest.token",
  "read.token",
]);

export function writeAtomicFile(file, value) {
  assertNoSymlink(file);
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, value, "utf8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    secureFile(file);
    const dirFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
    );
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the atomic-write error.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Process death is handled by cleanupAtomicTemps on the next lock owner.
    }
    throw error;
  }
}

export function cleanupAtomicTemps(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = /^\.(.+)\.\d+\.[0-9a-f]{16}\.tmp$/.exec(entry.name);
    if (!match || !ATOMIC_STATE_FILES.has(match[1])) continue;
    const file = path.join(directory, entry.name);
    secureFile(file);
    fs.unlinkSync(file);
  }
}

export function writeAtomicJson(file, value) {
  writeAtomicFile(file, `${JSON.stringify(value)}\n`);
}

export function readBoundedText(file, maxBytes = 64 * 1024) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new Error("invalid-protected-file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== process.getuid?.() ||
      opened.size > maxBytes
    ) {
      throw new Error("invalid-protected-file");
    }
    fs.fchmodSync(fd, 0o600);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readJson(file, maxBytes = 64 * 1024) {
  return JSON.parse(readBoundedText(file, maxBytes));
}

export function mintToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function rotateTokens(paths) {
  const ingest = mintToken();
  let read = mintToken();
  while (read === ingest) read = mintToken();
  writeAtomicFile(paths.ingestToken, `${ingest}\n`);
  writeAtomicFile(paths.readToken, `${read}\n`);
  return { ingest, read };
}

export function readToken(file) {
  const value = readBoundedText(file, 256).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("invalid-token-file");
  return value;
}

export function removeMatchingState(file, startToken) {
  try {
    const current = readJson(file);
    if (current?.startToken !== startToken) return false;
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return true;
    return false;
  }
}
