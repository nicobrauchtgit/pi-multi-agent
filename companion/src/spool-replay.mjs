import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeProducerEnvelope } from "../../extensions/shared/observability/normalize.mjs";
import { LIMITS } from "./constants.mjs";
import {
  inspectProtectedFile,
  pathMatchesProtectedIdentity,
  readStableProtectedFile,
  secureDirectory,
  secureFile,
  unlinkProtectedFile,
} from "./fsguard.mjs";
import { receiveBatch } from "./ingest/receive.mjs";
import { writeAtomicFile, writeAtomicJson } from "./state.mjs";

const PRODUCER_ID =
  /^producer_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT = /^(\d{8})\.ndjson$/;
const TEMP = /^\.(\d{8})\.ndjson\.\d+\.[0-9a-f]{16}\.tmp$/;
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
const STALE_TEMP_MS = 30_000;

function quarantineMetadata(paths, reason, count) {
  try {
    const name = `quarantine-${Date.now()}-${randomBytes(6).toString("hex")}.json`;
    writeAtomicJson(path.join(paths.quarantineDir, name), {
      version: 1,
      reason,
      count,
    });
  } catch {
    // Counters remain the only diagnostic if disk pressure blocks metadata.
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return Boolean(
      error && typeof error === "object" && error.code === "ENOENT",
    );
  }
}

export function createDaemonSpoolReplayer(options) {
  let running;
  let stopped = false;

  const recoverTemps = () => {
    const now = Date.now();
    for (const entry of fs.readdirSync(options.paths.spoolDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !PRODUCER_ID.test(entry.name)) continue;
      const directory = path.join(options.paths.spoolDir, entry.name);
      try {
        secureDirectory(directory, { tighten: true });
      } catch {
        continue;
      }
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        const match = child.isFile() ? TEMP.exec(child.name) : null;
        if (!match) continue;
        const temporary = path.join(directory, child.name);
        let observed;
        try {
          observed = fs.lstatSync(temporary);
        } catch {
          continue;
        }
        if (!observed.isFile() || now - observed.mtimeMs < STALE_TEMP_MS) {
          continue;
        }
        let stable;
        try {
          stable = readStableProtectedFile(temporary, SEGMENT_MAX_BYTES);
        } catch {
          // A concurrent rename or unreadable/hostile entry is not malformed.
          continue;
        }
        try {
          const { bytes, identity } = stable;
          if (!pathMatchesProtectedIdentity(temporary, identity)) continue;
          const lastNewline = bytes.lastIndexOf(0x0a);
          if (lastNewline < 0) {
            options.metrics.increment("spoolPartialTails");
            quarantineMetadata(options.paths, "stale-temp-no-complete-line", 1);
            unlinkProtectedFile(temporary, identity);
            continue;
          }
          if (lastNewline !== bytes.length - 1) {
            options.metrics.increment("spoolPartialTails");
          }
          const safeLines = [];
          let malformed = 0;
          for (const line of bytes
            .subarray(0, lastNewline)
            .toString("utf8")
            .split("\n")) {
            try {
              const parsed = JSON.parse(line);
              safeLines.push(
                normalizeProducerEnvelope(parsed, {
                  contentMode: parsed?.capture?.contentMode,
                }).serialized,
              );
            } catch {
              malformed++;
            }
          }
          if (!pathMatchesProtectedIdentity(temporary, identity)) continue;
          if (malformed > 0) {
            options.metrics.increment("spoolMalformed", malformed);
            quarantineMetadata(
              options.paths,
              "stale-temp-malformed-records",
              malformed,
            );
          }
          if (safeLines.length === 0) {
            unlinkProtectedFile(temporary, identity);
            continue;
          }
          let sequence = Number(match[1]);
          let target;
          do {
            target = path.join(
              directory,
              `${String(sequence++).padStart(8, "0")}.ndjson`,
            );
          } while (fs.existsSync(target) && sequence <= 99_999_999);
          if (fs.existsSync(target))
            throw new Error("spool-sequence-exhausted");
          writeAtomicFile(target, `${safeLines.join("\n")}\n`);
          unlinkProtectedFile(temporary, identity);
        } catch (error) {
          if (
            !pathMatchesProtectedIdentity(temporary, stable.identity) ||
            (error &&
              typeof error === "object" &&
              ["ENOENT", "EACCES", "EPERM"].includes(String(error.code)))
          ) {
            continue;
          }
          options.metrics.increment("spoolMalformed");
          quarantineMetadata(options.paths, "stale-temp-invalid", 1);
          unlinkProtectedFile(temporary, stable.identity);
        }
      }
    }
  };

  const scan = () => {
    const output = [];
    secureDirectory(options.paths.spoolDir, { tighten: true });
    for (const entry of fs.readdirSync(options.paths.spoolDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !PRODUCER_ID.test(entry.name)) continue;
      const directory = path.join(options.paths.spoolDir, entry.name);
      try {
        secureDirectory(directory, { tighten: true });
      } catch {
        continue;
      }
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!child.isFile() || !SEGMENT.test(child.name)) continue;
        const file = path.join(directory, child.name);
        try {
          const identity = inspectProtectedFile(file);
          if (identity.size > SEGMENT_MAX_BYTES) {
            options.metrics.increment("spoolMalformed");
            quarantineMetadata(options.paths, "segment-too-large", 1);
            unlinkProtectedFile(file, identity);
            continue;
          }
          output.push({
            directory,
            file,
            producerId: entry.name,
            name: child.name,
          });
        } catch {
          // Never follow or parse a hostile entry.
        }
      }
    }
    return output.sort(
      (left, right) =>
        left.producerId.localeCompare(right.producerId) ||
        left.name.localeCompare(right.name),
    );
  };

  const run = async () => {
    recoverTemps();
    let visited = 0;
    for (const segment of scan()) {
      if (stopped || visited++ >= 64) break;
      let stable;
      try {
        stable = readStableProtectedFile(segment.file, SEGMENT_MAX_BYTES);
        if (!pathMatchesProtectedIdentity(segment.file, stable.identity)) {
          continue;
        }
      } catch {
        continue;
      }
      const { bytes } = stable;
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        options.metrics.increment("spoolPartialTails");
        quarantineMetadata(options.paths, "partial-segment", 1);
        unlinkProtectedFile(segment.file, stable.identity);
        continue;
      }
      if (lastNewline !== bytes.length - 1) {
        options.metrics.increment("spoolPartialTails");
      }
      const rawLines = bytes
        .subarray(0, lastNewline)
        .toString("utf8")
        .split("\n");
      const events = [];
      let malformed = 0;
      for (const line of rawLines) {
        if (
          !line ||
          Buffer.byteLength(line, "utf8") > LIMITS.storedEventBytes
        ) {
          malformed++;
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          events.push(
            normalizeProducerEnvelope(parsed, {
              contentMode: parsed?.capture?.contentMode,
            }).event,
          );
        } catch {
          malformed++;
        }
      }
      let terminal = true;
      for (let offset = 0; offset < events.length;) {
        const batch = events.slice(offset, offset + LIMITS.batchEvents);
        try {
          const result = receiveBatch(options.db, batch, Date.now(), {
            statements: options.statements,
            metrics: options.metrics,
            policyConfig: options.config.current(),
          });
          if (
            result.results.some(
              (entry) =>
                !entry ||
                !["accepted", "duplicate", "conflict", "rejected"].includes(
                  entry.status,
                ),
            )
          ) {
            terminal = false;
            break;
          }
        } catch {
          terminal = false;
          break;
        }
        offset += batch.length;
      }
      if (!terminal) break;
      if (malformed > 0) {
        options.metrics.increment("spoolMalformed", malformed);
        quarantineMetadata(options.paths, "malformed-records", malformed);
      }
      if (unlinkProtectedFile(segment.file, stable.identity)) {
        options.metrics.increment("spoolSegmentsReplayed");
        options.metrics.increment("spoolRecordsReplayed", events.length);
      }
      try {
        const entries = fs.readdirSync(segment.directory);
        if (entries.length === 1 && entries[0] === "state.json") {
          // Producer-local ACK/counter state is only an optimization. Once a
          // foreign directory has no replayable bytes, remove it for GC.
          secureFile(path.join(segment.directory, "state.json"));
          safeUnlink(path.join(segment.directory, "state.json"));
        }
        if (fs.readdirSync(segment.directory).length === 0) {
          fs.rmdirSync(segment.directory);
        }
      } catch {
        // Producer may have created another segment concurrently.
      }
    }
    try {
      options.metrics.flush();
    } catch {
      // Replay remains idempotent if only metrics fail.
    }
  };

  const runOnce = () => {
    if (stopped) return Promise.resolve();
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  };

  const timer = setInterval(() => void runOnce(), 1_000);
  timer.unref();
  return Object.freeze({
    runOnce,
    close() {
      stopped = true;
      clearInterval(timer);
    },
  });
}
