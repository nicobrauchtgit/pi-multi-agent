import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ObservabilityEvent } from "../../shared/observability/events.ts";
import type { ObservabilityPaths } from "../../shared/observability/home.mjs";
import {
  OBSERVABILITY_LIMITS,
  normalizeProducerEnvelope,
} from "../../shared/observability/normalize.mjs";
import {
  isProducerId,
  type ProducerId,
} from "../../shared/observability/ids.ts";
import {
  ensureProducerTree,
  inspectProtectedFile,
  pathMatchesProtectedIdentity,
  readProtectedJson,
  readStableProtectedFile,
  secureDirectory,
  secureFile,
  unlinkProtectedFile,
  writeAtomicProtectedJson,
  type ProtectedFileIdentity,
} from "./protected-fs.ts";

export const SPOOL_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
export const SPOOL_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const SPOOL_STALE_TEMP_MS = 30_000;
const SEGMENT_NAME = /^(\d{8})\.ndjson$/;
const TEMP_NAME = /^\.(\d{8})\.ndjson\.\d+\.[0-9a-f]{16}\.tmp$/;
const PRODUCER_STATE_NAME = "state.json";
const PRODUCER_ACK_MAX = 1_024;
const COALESCABLE_KINDS = new Set(["agent.usage", "agent.meta"]);

export interface NormalizedQueueEvent {
  readonly event: ObservabilityEvent<string, Record<string, unknown>>;
  readonly serialized: string;
  readonly bytes: number;
  readonly coalescable: boolean;
}

export interface SpoolCounters {
  segmentsWritten: number;
  segmentsReplayed: number;
  recordsReplayed: number;
  partialTails: number;
  malformedRecords: number;
  quarantined: number;
  evictedSegments: number;
  evictedRecords: number;
  writeFailures: number;
  replayFailures: number;
}

interface SpoolState {
  version: 1;
  acks: Record<string, number>;
  counts: SpoolCounters;
}

interface Segment {
  readonly producerId: ProducerId;
  readonly name: string;
  readonly file: string;
  readonly relative: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ReplayResult {
  /** One terminal flag per submitted event; terminal includes rejected/conflict. */
  readonly terminal: readonly boolean[];
}

function emptyCounters(): SpoolCounters {
  return {
    segmentsWritten: 0,
    segmentsReplayed: 0,
    recordsReplayed: 0,
    partialTails: 0,
    malformedRecords: 0,
    quarantined: 0,
    evictedSegments: 0,
    evictedRecords: 0,
    writeFailures: 0,
    replayFailures: 0,
  };
}

function nonnegative(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function loadState(file: string): SpoolState {
  try {
    const input = readProtectedJson(file, 128 * 1024) as {
      version?: unknown;
      acks?: unknown;
      counts?: unknown;
    };
    const acks: Record<string, number> = {};
    if (
      input.acks &&
      typeof input.acks === "object" &&
      !Array.isArray(input.acks)
    ) {
      for (const [key, value] of Object.entries(input.acks).slice(
        0,
        PRODUCER_ACK_MAX,
      )) {
        if (/^producer_[0-9a-f-]+\/\d{8}\.ndjson$/.test(key)) {
          acks[key] = nonnegative(value);
        }
      }
    }
    const source =
      input.counts &&
      typeof input.counts === "object" &&
      !Array.isArray(input.counts)
        ? (input.counts as Record<string, unknown>)
        : {};
    const counts = emptyCounters();
    for (const key of Object.keys(counts) as Array<keyof SpoolCounters>) {
      counts[key] = nonnegative(source[key]);
    }
    return { version: 1, acks, counts };
  } catch {
    return { version: 1, acks: {}, counts: emptyCounters() };
  }
}

function segmentLineBytes(records: readonly NormalizedQueueEvent[]) {
  return records.reduce((total, record) => total + record.bytes + 1, 0);
}

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function producerDirectory(paths: ObservabilityPaths, producerId: ProducerId) {
  if (!isProducerId(producerId)) throw new Error("invalid-producer-id");
  const directory = path.join(paths.spoolDir, producerId);
  if (!contained(paths.spoolDir, directory))
    throw new Error("producer-path-escape");
  return directory;
}

function safeUnlink(file: string) {
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

export function createProtectedSpool(options: {
  paths: ObservabilityPaths;
  producerId: ProducerId;
  maxBytes?: number;
  segmentMaxBytes?: number;
  staleTempMs?: number;
}) {
  const { paths, producerId } = options;
  const maxBytes = Math.max(
    1024 * 1024,
    Math.floor(options.maxBytes ?? SPOOL_DEFAULT_MAX_BYTES),
  );
  const segmentMaxBytes = Math.min(
    SPOOL_SEGMENT_MAX_BYTES,
    Math.max(
      OBSERVABILITY_LIMITS.storedEventBytes + 1,
      options.segmentMaxBytes ?? SPOOL_SEGMENT_MAX_BYTES,
    ),
  );
  const staleTempMs = options.staleTempMs ?? SPOOL_STALE_TEMP_MS;
  ensureProducerTree(paths);
  const ownDirectory = producerDirectory(paths, producerId);
  secureDirectory(ownDirectory, { create: true });
  // ACK/counter state is producer-local. A shared root file was vulnerable to
  // concurrent last-writer-wins clobbering across independent Pi processes.
  const stateFile = path.join(ownDirectory, PRODUCER_STATE_NAME);
  let state = loadState(stateFile);

  const persistState = () => {
    try {
      writeAtomicProtectedJson(stateFile, state);
    } catch {
      // State is an optimization. Immutable segments and eventId idempotency
      // remain the correctness boundary after a state-write failure.
    }
  };

  const count = (key: keyof SpoolCounters, amount = 1) => {
    state.counts[key] =
      nonnegative(state.counts[key]) + Math.max(0, Math.floor(amount));
  };

  const setAck = (relative: string, offset: number) => {
    if (
      !Object.hasOwn(state.acks, relative) &&
      Object.keys(state.acks).length >= PRODUCER_ACK_MAX
    ) {
      delete state.acks[Object.keys(state.acks)[0]!];
    }
    state.acks[relative] = offset;
  };

  const checkDeadline = (deadline?: number) => {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error("spool-deadline");
    }
  };

  const scanSegments = (deadline?: number): Segment[] => {
    const output: Segment[] = [];
    secureDirectory(paths.spoolDir, { tighten: true });
    for (const entry of fs.readdirSync(paths.spoolDir, {
      withFileTypes: true,
    })) {
      checkDeadline(deadline);
      if (!entry.isDirectory() || !isProducerId(entry.name)) continue;
      const directory = producerDirectory(paths, entry.name);
      try {
        secureDirectory(directory, { tighten: true });
      } catch {
        continue;
      }
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        checkDeadline(deadline);
        if (!child.isFile() || !SEGMENT_NAME.test(child.name)) continue;
        const file = path.join(directory, child.name);
        if (!contained(directory, file)) continue;
        try {
          const identity = inspectProtectedFile(file);
          if (identity.size > segmentMaxBytes) {
            quarantine(file, "segment-too-large", identity);
            continue;
          }
          output.push({
            producerId: entry.name,
            name: child.name,
            file,
            relative: `${entry.name}/${child.name}`,
            mtimeMs: identity.mtimeMs,
            size: identity.size,
          });
        } catch {
          // A hostile/symlink/wrong-owner entry is ignored without reading it.
        }
      }
    }
    return output.sort(
      (left, right) =>
        left.producerId.localeCompare(right.producerId) ||
        left.name.localeCompare(right.name),
    );
  };

  const quarantine = (
    file: string,
    reason: string,
    identity?: ProtectedFileIdentity,
  ) => {
    const removed = identity
      ? unlinkProtectedFile(file, identity)
      : safeUnlink(file);
    if (!removed) return;
    try {
      // Do not preserve unknown bytes. Keep only a payload-free diagnostic.
      const name = `quarantine-${Date.now()}-${randomBytes(6).toString("hex")}.json`;
      writeAtomicProtectedJson(path.join(paths.quarantineDir, name), {
        version: 1,
        reason: reason.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 80),
      });
      count("quarantined");
      persistState();
    } catch {
      // The unsafe bytes are already gone; counters are best effort.
    }
  };

  const recoverStaleTemps = () => {
    const now = Date.now();
    for (const entry of fs.readdirSync(paths.spoolDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !isProducerId(entry.name)) continue;
      const directory = producerDirectory(paths, entry.name);
      try {
        secureDirectory(directory, { tighten: true });
      } catch {
        continue;
      }
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        const match = child.isFile() ? TEMP_NAME.exec(child.name) : null;
        if (!match) continue;
        const temporary = path.join(directory, child.name);
        let observed;
        try {
          observed = fs.lstatSync(temporary);
        } catch {
          continue;
        }
        if (!observed.isFile() || now - observed.mtimeMs < staleTempMs) {
          continue;
        }
        let stable;
        try {
          stable = readStableProtectedFile(temporary, segmentMaxBytes);
        } catch {
          // A concurrent rename or unreadable/hostile entry is not malformed.
          continue;
        }
        try {
          const { bytes, identity } = stable;
          if (!pathMatchesProtectedIdentity(temporary, identity)) continue;
          const lastNewline = bytes.lastIndexOf(0x0a);
          if (lastNewline < 0) {
            count("partialTails");
            quarantine(temporary, "stale-temp-no-complete-line", identity);
            continue;
          }
          if (lastNewline !== bytes.length - 1) count("partialTails");
          const complete = bytes.subarray(0, lastNewline + 1);
          // Validate every promoted line before creating another disk byte.
          for (const line of complete.toString("utf8").trimEnd().split("\n")) {
            const parsed = JSON.parse(line);
            normalizeProducerEnvelope(parsed, {
              contentMode: parsed?.capture?.contentMode,
            });
          }
          if (!pathMatchesProtectedIdentity(temporary, identity)) continue;
          let target = path.join(directory, `${match[1]}.ndjson`);
          if (fs.existsSync(target)) {
            target = path.join(directory, nextSegmentName(directory));
          }
          const promoted = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.promote`;
          let fd: number | undefined;
          try {
            fd = fs.openSync(promoted, "wx", 0o600);
            fs.writeFileSync(fd, complete);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(promoted, target);
            secureFile(target);
            unlinkProtectedFile(temporary, identity);
          } catch (error) {
            if (fd !== undefined) fs.closeSync(fd);
            safeUnlink(promoted);
            throw error;
          }
        } catch (error) {
          if (
            !pathMatchesProtectedIdentity(temporary, stable.identity) ||
            (error &&
              typeof error === "object" &&
              "code" in error &&
              ["ENOENT", "EACCES", "EPERM"].includes(String(error.code)))
          ) {
            continue;
          }
          quarantine(temporary, "stale-temp-invalid", stable.identity);
        }
      }
    }
    persistState();
  };

  const nextSegmentName = (directory = ownDirectory) => {
    let highest = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const match = SEGMENT_NAME.exec(entry.name);
      if (entry.isFile() && match)
        highest = Math.max(highest, Number(match[1]));
    }
    const next = highest + 1;
    if (!Number.isSafeInteger(next) || next > 99_999_999) {
      throw new Error("spool-sequence-exhausted");
    }
    return `${String(next).padStart(8, "0")}.ndjson`;
  };

  const scanAuxiliaryFiles = (deadline?: number) => {
    const files: Array<{
      file: string;
      size: number;
      mtimeMs: number;
      identity: ProtectedFileIdentity;
    }> = [];
    try {
      secureDirectory(paths.quarantineDir, { tighten: true });
      for (const entry of fs.readdirSync(paths.quarantineDir, {
        withFileTypes: true,
      })) {
        checkDeadline(deadline);
        if (
          !entry.isFile() ||
          !/^quarantine-[0-9]+-[0-9a-f]+\.json$/.test(entry.name)
        ) {
          continue;
        }
        const file = path.join(paths.quarantineDir, entry.name);
        try {
          const identity = inspectProtectedFile(file);
          files.push({
            file,
            size: identity.size,
            mtimeMs: identity.mtimeMs,
            identity,
          });
        } catch {
          // Hostile auxiliary entries are not followed.
        }
      }
    } catch {
      // Cap enforcement will fail the next write if the tree is unavailable.
    }
    const now = Date.now();
    for (const entry of fs.readdirSync(paths.spoolDir, {
      withFileTypes: true,
    })) {
      checkDeadline(deadline);
      if (!entry.isDirectory() || !isProducerId(entry.name)) continue;
      const directory = producerDirectory(paths, entry.name);
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        checkDeadline(deadline);
        if (
          !child.isFile() ||
          (!TEMP_NAME.test(child.name) && child.name !== PRODUCER_STATE_NAME)
        ) {
          continue;
        }
        const file = path.join(directory, child.name);
        try {
          const identity = inspectProtectedFile(file);
          // Never evict an actively written temp, but charge its observed size.
          files.push({
            file,
            size: identity.size,
            mtimeMs:
              child.name === PRODUCER_STATE_NAME ||
              now - identity.mtimeMs >= staleTempMs
                ? identity.mtimeMs
                : Number.POSITIVE_INFINITY,
            identity,
          });
        } catch {
          // Hostile auxiliary entries are not followed.
        }
      }
    }
    return files;
  };

  const readKinds = (segment: Segment) => {
    try {
      const stable = readStableProtectedFile(segment.file, segmentMaxBytes);
      if (!pathMatchesProtectedIdentity(segment.file, stable.identity)) {
        return undefined;
      }
      const text = stable.bytes.toString("utf8");
      const lines = text.endsWith("\n")
        ? text.slice(0, -1).split("\n")
        : text.split("\n").slice(0, -1);
      let kinds: unknown[];
      try {
        kinds = lines.map((line) => JSON.parse(line)?.kind);
      } catch {
        kinds = [];
      }
      return { kinds, identity: stable.identity };
    } catch {
      return undefined;
    }
  };

  const enforceCap = (reserveBytes = 0, deadline?: number) => {
    const segments = scanSegments(deadline);
    const auxiliary = scanAuxiliaryFiles(deadline);
    let total =
      segments.reduce((sum, segment) => sum + segment.size, 0) +
      auxiliary.reduce((sum, file) => sum + file.size, 0);
    if (total + reserveBytes <= maxBytes) return;
    for (const file of auxiliary.sort(
      (left, right) => left.mtimeMs - right.mtimeMs,
    )) {
      checkDeadline(deadline);
      if (total + reserveBytes <= maxBytes) break;
      if (!Number.isFinite(file.mtimeMs)) continue;
      if (unlinkProtectedFile(file.file, file.identity)) total -= file.size;
    }
    const coalescable: Array<{
      segment: Segment;
      kinds: unknown[];
      identity: ProtectedFileIdentity;
    }> = [];
    const durable: typeof coalescable = [];
    for (const segment of segments) {
      checkDeadline(deadline);
      const inspected = readKinds(segment);
      if (!inspected) continue;
      const candidate = { segment, ...inspected };
      (inspected.kinds.length > 0 &&
      inspected.kinds.every(
        (kind) => typeof kind === "string" && COALESCABLE_KINDS.has(kind),
      )
        ? coalescable
        : durable
      ).push(candidate);
    }
    const candidates = [...coalescable, ...durable].sort(
      (left, right) => left.identity.mtimeMs - right.identity.mtimeMs,
    );
    for (const candidate of candidates) {
      checkDeadline(deadline);
      if (total + reserveBytes <= maxBytes) break;
      if (unlinkProtectedFile(candidate.segment.file, candidate.identity)) {
        total -= candidate.identity.size;
        delete state.acks[candidate.segment.relative];
        count("evictedSegments");
        count("evictedRecords", candidate.kinds.length);
      }
    }
    persistState();
  };

  const writeChunk = (
    records: readonly NormalizedQueueEvent[],
    deadline?: number,
  ) => {
    checkDeadline(deadline);
    // The daemon may GC an emptied producer directory after adopting its last
    // segment. Recreate and verify it before the next immutable write.
    secureDirectory(ownDirectory, { create: true });
    const bytes = segmentLineBytes(records);
    if (bytes > segmentMaxBytes) throw new Error("spool-segment-limit");
    enforceCap(bytes, deadline);
    checkDeadline(deadline);
    const currentBytes =
      scanSegments(deadline).reduce((sum, segment) => sum + segment.size, 0) +
      scanAuxiliaryFiles(deadline).reduce((sum, file) => sum + file.size, 0);
    if (currentBytes + bytes > maxBytes) throw new Error("spool-cap-exhausted");
    const name = nextSegmentName();
    const finalFile = path.join(ownDirectory, name);
    if (!contained(ownDirectory, finalFile))
      throw new Error("segment-path-escape");
    const temporary = path.join(
      ownDirectory,
      `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      for (const record of records)
        fs.writeSync(fd, `${record.serialized}\n`, undefined, "utf8");
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, finalFile);
      secureFile(finalFile);
      const directoryFd = fs.openSync(
        ownDirectory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
      );
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
      count("segmentsWritten");
      persistState();
      return finalFile;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve primary failure.
        }
      }
      safeUnlink(temporary);
      count("writeFailures");
      persistState();
      throw error;
    }
  };

  const writeRecords = (
    records: readonly NormalizedQueueEvent[],
    options: { deadline?: number } = {},
  ) => {
    const files: string[] = [];
    let chunk: NormalizedQueueEvent[] = [];
    let bytes = 0;
    for (const record of records) {
      if (record.bytes + 1 > segmentMaxBytes) {
        count("writeFailures");
        continue;
      }
      if (chunk.length > 0 && bytes + record.bytes + 1 > segmentMaxBytes) {
        checkDeadline(options.deadline);
        files.push(writeChunk(chunk, options.deadline));
        chunk = [];
        bytes = 0;
      }
      chunk.push(record);
      bytes += record.bytes + 1;
    }
    if (chunk.length > 0) {
      checkDeadline(options.deadline);
      files.push(writeChunk(chunk, options.deadline));
    }
    return files;
  };

  const parseSegment = (segment: Segment) => {
    const { bytes, identity } = readStableProtectedFile(
      segment.file,
      segmentMaxBytes,
    );
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      count("partialTails");
      return {
        events: [] as ObservabilityEvent<string, Record<string, unknown>>[],
        malformed: 1,
        identity,
      };
    }
    if (lastNewline !== bytes.length - 1) count("partialTails");
    const lines = bytes.subarray(0, lastNewline).toString("utf8").split("\n");
    const events: ObservabilityEvent<string, Record<string, unknown>>[] = [];
    let malformed = 0;
    for (const line of lines) {
      if (
        !line ||
        Buffer.byteLength(line, "utf8") > OBSERVABILITY_LIMITS.storedEventBytes
      ) {
        malformed++;
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const normalized = normalizeProducerEnvelope(parsed, {
          contentMode: parsed?.capture?.contentMode,
        });
        events.push(normalized.event);
      } catch {
        malformed++;
      }
    }
    if (malformed > 0) count("malformedRecords", malformed);
    return { events, malformed, identity };
  };

  const deleteIfEmptyProducerDirectory = (directory: string) => {
    if (directory === ownDirectory) return;
    try {
      const entries = fs.readdirSync(directory);
      if (entries.length === 1 && entries[0] === PRODUCER_STATE_NAME) {
        safeUnlink(path.join(directory, PRODUCER_STATE_NAME));
      }
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      // GC is best effort.
    }
  };

  const replay = async (
    send: (
      events: readonly ObservabilityEvent<string, Record<string, unknown>>[],
    ) => Promise<ReplayResult>,
    options: { deadline?: number; maxSegments?: number } = {},
  ) => {
    recoverStaleTemps();
    let visited = 0;
    for (const segment of scanSegments()) {
      if (options.deadline !== undefined && Date.now() >= options.deadline)
        break;
      if (visited++ >= (options.maxSegments ?? 64)) break;
      let parsed;
      try {
        parsed = parseSegment(segment);
      } catch {
        count("replayFailures");
        continue;
      }
      const watermark = Math.min(
        state.acks[segment.relative] ?? 0,
        parsed.events.length,
      );
      let offset = watermark;
      let transient = false;
      while (offset < parsed.events.length) {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          transient = true;
          break;
        }
        const batch: ObservabilityEvent<string, Record<string, unknown>>[] = [];
        let batchBytes = 0;
        while (
          offset + batch.length < parsed.events.length &&
          batch.length < OBSERVABILITY_LIMITS.batchEvents
        ) {
          const event = parsed.events[offset + batch.length];
          const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
          if (
            batch.length > 0 &&
            batchBytes + bytes > OBSERVABILITY_LIMITS.batchBytes
          )
            break;
          batch.push(event);
          batchBytes += bytes;
        }
        let result: ReplayResult;
        try {
          result = await send(batch);
        } catch {
          count("replayFailures");
          transient = true;
          break;
        }
        let contiguous = 0;
        for (const terminal of result.terminal) {
          if (!terminal) break;
          contiguous++;
        }
        if (contiguous === 0) {
          transient = true;
          break;
        }
        offset += contiguous;
        setAck(segment.relative, offset);
        persistState();
        if (contiguous < batch.length) {
          transient = true;
          break;
        }
      }
      if (!transient && offset >= parsed.events.length) {
        // Malformed/partial records are terminally discarded with counts only.
        if (parsed.malformed > 0) {
          try {
            const name = `quarantine-${Date.now()}-${randomBytes(6).toString("hex")}.json`;
            writeAtomicProtectedJson(path.join(paths.quarantineDir, name), {
              version: 1,
              reason: "malformed-records",
              count: parsed.malformed,
            });
            count("quarantined");
          } catch {
            // Segment deletion still prevents untrusted bytes lingering.
          }
        }
        const removed = unlinkProtectedFile(segment.file, parsed.identity);
        delete state.acks[segment.relative];
        if (removed) {
          count("segmentsReplayed");
          count("recordsReplayed", parsed.events.length);
          deleteIfEmptyProducerDirectory(path.dirname(segment.file));
        }
        persistState();
      }
      if (transient) break;
    }
    const remainingSegments = scanSegments();
    const live = new Set(remainingSegments.map((segment) => segment.relative));
    for (const relative of Object.keys(state.acks)) {
      if (!live.has(relative)) delete state.acks[relative];
    }
    persistState();
    enforceCap();
    return { ...state.counts };
  };

  return Object.freeze({
    producerId,
    paths,
    writeRecords,
    replay,
    recoverStaleTemps,
    enforceCap,
    scanSegments: () =>
      scanSegments().map(({ file, relative, size }) => ({
        file,
        relative,
        size,
      })),
    get counters() {
      return { ...state.counts };
    },
  });
}

export type ProtectedSpool = ReturnType<typeof createProtectedSpool>;
