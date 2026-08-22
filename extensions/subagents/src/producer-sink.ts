import { isChildExtensionLoad } from "../../shared/child-session.ts";
import type {
  ContentMode,
  ObservabilityEvent,
  PendingObservabilityEvent,
} from "../../shared/observability/events.ts";
import type { ObservabilityPaths } from "../../shared/observability/home.mjs";
import { normalizeProducerEnvelope } from "../../shared/observability/normalize.mjs";
import {
  minimumContentMode,
  resolveProjectPolicy,
  type ObservabilityPolicyConfig,
} from "../../shared/observability/policy.mjs";
import {
  isProducerId,
  mintProducerId,
  type ProducerId,
} from "../../shared/observability/ids.ts";
import type { ObservabilitySink } from "../../shared/observability/sink.ts";
import {
  createDaemonTransport,
  type DaemonTransport,
} from "./daemon-transport.ts";
import {
  createProtectedSpool,
  type NormalizedQueueEvent,
  type ProtectedSpool,
} from "./spool.ts";

export const PRODUCER_QUEUE_MAX_EVENTS = 512;
export const PRODUCER_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const PRODUCER_BATCH_MAX_EVENTS = 64;
export const PRODUCER_BATCH_MAX_BYTES = 512 * 1024;
export const PRODUCER_FLUSH_INTERVAL_MS = 100;
const REPLAY_RETRY_MS = 1_000;
const PRODUCER_REGISTRY = Symbol.for(
  "pi-multi-agent.observability.producer.v1",
);
const COALESCABLE_KINDS = new Set(["agent.usage", "agent.meta"]);

export interface ProducerSinkStats {
  readonly producerId: ProducerId;
  readonly producerSeq: number;
  readonly accepted: number;
  readonly normalizedDropped: number;
  readonly coalesced: number;
  readonly pressureDropped: number;
  readonly pressureSpooled: number;
  readonly queueEvents: number;
  readonly queueBytes: number;
  readonly healthTransitions: number;
  readonly reasons: Readonly<Record<string, number>>;
}

export interface ProducerObservabilitySink extends ObservabilitySink {
  readonly producerId: ProducerId;
  readonly paths: ObservabilityPaths;
  readonly config: ObservabilityPolicyConfig;
  readonly closed: boolean;
  readonly stats: ProducerSinkStats;
  contentModeFor(projectRoot?: string): ContentMode;
  recordDiagnostic(reason: string, amount?: number): void;
  close(budgetMs: number): Promise<void>;
}

interface RegistrySlot {
  sink?: ProducerObservabilitySink;
}

function registry(): RegistrySlot {
  const root = globalThis as typeof globalThis & {
    [PRODUCER_REGISTRY]?: RegistrySlot;
  };
  return (root[PRODUCER_REGISTRY] ??= {});
}

function safeReason(value: string) {
  return value.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 80) || "unknown";
}

function coalescingKey(
  event: Pick<ObservabilityEvent<string>, "kind" | "ids" | "payload">,
) {
  if (!COALESCABLE_KINDS.has(event.kind)) return undefined;
  return `${event.kind}:${event.ids.agentId ?? event.ids.runId ?? "root"}:${String(
    (event.payload as { update?: unknown } | undefined)?.update ?? "",
  )}`;
}

function deadlinePromise(deadline: number) {
  return new Promise<void>((resolve) => {
    const remaining = Math.max(0, deadline - Date.now());
    setTimeout(resolve, remaining);
  });
}

/**
 * Process-wide producer. emit() performs bounded normalization/enqueue work;
 * project-path classification may synchronously canonicalize an uncached path.
 * Network I/O and normal spool writes run in the serial worker. The hard-
 * pressure path synchronously writes one already-redacted record rather than
 * losing a lifecycle boundary.
 */
export function createProducerSink(options: {
  paths: ObservabilityPaths;
  config: ObservabilityPolicyConfig;
  producerId?: ProducerId;
  /** False in production until every enabled backend has an enforceable shell boundary. */
  richAllowed?: boolean;
  ensureDaemon?: () => Promise<unknown>;
  onHealth?: (
    state: "healthy" | "degraded" | "unavailable",
    reason: string,
  ) => void;
  spool?: ProtectedSpool;
  transport?: DaemonTransport;
}): ProducerObservabilitySink {
  if (isChildExtensionLoad()) {
    throw new Error(
      "A child extension load cannot create an observability producer.",
    );
  }
  const shared = registry();
  if (shared.sink && !shared.sink.closed) return shared.sink;

  const producerId = options.producerId ?? mintProducerId();
  if (!isProducerId(producerId)) throw new Error("invalid-producer-id");
  const richAllowed = options.richAllowed === true;
  const spool =
    options.spool ??
    createProtectedSpool({
      paths: options.paths,
      producerId,
      maxBytes: options.config.defaults.maxSpoolBytes,
    });
  let healthTransitions = 0;
  let lastHealthState: "healthy" | "degraded" | "unavailable" | undefined;
  const transport =
    options.transport ??
    createDaemonTransport({
      paths: options.paths,
      ensureDaemon: options.ensureDaemon,
      onHealth: (state, reason) => {
        if (state !== lastHealthState) {
          healthTransitions++;
          lastHealthState = state;
        }
        options.onHealth?.(state, reason);
      },
    });

  const queue: NormalizedQueueEvent[] = [];
  const coalescedByKey = new Map<string, NormalizedQueueEvent>();
  const reasons: Record<string, number> = Object.create(null);
  const projectCache = new Map<string, ContentMode>();
  let queueBytes = 0;
  let producerSeq = 0;
  let accepted = 0;
  let normalizedDropped = 0;
  let coalesced = 0;
  let pressureDropped = 0;
  let pressureSpooled = 0;
  let accepting = true;
  let isClosed = false;
  let normalizing = false;
  let worker: Promise<void> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;

  const note = (reason: string, amount = 1) => {
    const key = safeReason(reason);
    reasons[key] = (reasons[key] ?? 0) + Math.max(0, Math.floor(amount));
  };

  const contentModeFor = (projectRoot?: string): ContentMode => {
    const cacheKey = projectRoot ?? "<none>";
    const cached = projectCache.get(cacheKey);
    if (cached) return cached;
    let mode: ContentMode;
    try {
      const policy = resolveProjectPolicy(options.config, projectRoot);
      mode = !policy.enabled
        ? "disabled"
        : minimumContentMode(
            policy.contentMode,
            richAllowed ? "rich" : "metadata",
          );
    } catch {
      mode = "disabled";
    }
    if (projectCache.size >= 256)
      projectCache.delete(projectCache.keys().next().value!);
    projectCache.set(cacheKey, mode);
    return mode;
  };

  const removeAt = (index: number, pressure = false) => {
    const [removed] = queue.splice(index, 1);
    if (!removed) return undefined;
    queueBytes -= removed.bytes;
    const key = coalescingKey(removed.event);
    if (key && coalescedByKey.get(key) === removed) coalescedByKey.delete(key);
    if (pressure) {
      pressureDropped++;
      note("queue-pressure-coalescable");
    }
    return removed;
  };

  const scheduleReplay = () => {
    if (replayTimer || isClosed) return;
    replayTimer = setTimeout(() => {
      replayTimer = undefined;
      void startWorker();
    }, REPLAY_RETRY_MS);
    replayTimer.unref?.();
  };

  const replayBacklog = async (deadline?: number) => {
    try {
      await spool.replay((events) => transport.send(events), {
        deadline,
        maxSegments: deadline === undefined ? 64 : Number.MAX_SAFE_INTEGER,
      });
    } catch {
      note("replay-failed");
    }
    if (spool.scanSegments().length > 0) scheduleReplay();
  };

  const takeBatch = () => {
    const batch: NormalizedQueueEvent[] = [];
    let bytes = 0;
    while (queue.length > 0 && batch.length < PRODUCER_BATCH_MAX_EVENTS) {
      const next = queue[0];
      if (batch.length > 0 && bytes + next.bytes > PRODUCER_BATCH_MAX_BYTES)
        break;
      const removed = removeAt(0);
      if (!removed) break;
      batch.push(removed);
      bytes += removed.bytes;
    }
    return batch;
  };

  const runWorker = async (deadline?: number) => {
    // Adopt every producer directory before allowing queued live traffic to
    // overtake an older immutable segment.
    await replayBacklog(deadline);
    while (
      queue.length > 0 &&
      (deadline === undefined || Date.now() < deadline)
    ) {
      const batch = takeBatch();
      if (batch.length === 0) break;
      try {
        spool.writeRecords(batch);
      } catch {
        note("spool-write-failed");
        try {
          await transport.send(batch.map((record) => record.event));
        } catch {
          // The only remaining option is a safe count. Never create an
          // unredacted fallback/emergency file.
          pressureDropped += batch.length;
          note("delivery-undurable", batch.length);
        }
      }
      await replayBacklog(deadline);
    }
  };

  const startWorker = (deadline?: number) => {
    if (!worker) {
      worker = runWorker(deadline)
        .catch(() => {
          note("worker-failed");
        })
        .finally(() => {
          worker = undefined;
          if (queue.length > 0 && !isClosed) scheduleFlush(0);
        });
    }
    return worker;
  };

  const scheduleFlush = (delay = PRODUCER_FLUSH_INTERVAL_MS) => {
    if (flushTimer || isClosed) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void startWorker();
    }, delay);
    flushTimer.unref?.();
  };

  const queueRecord = (record: NormalizedQueueEvent): boolean => {
    const key = coalescingKey(record.event);
    if (key) {
      const prior = coalescedByKey.get(key);
      if (prior) {
        const index = queue.indexOf(prior);
        if (index >= 0) removeAt(index);
        coalesced++;
        note("coalesced");
      }
    }

    while (
      queue.length >= PRODUCER_QUEUE_MAX_EVENTS ||
      queueBytes + record.bytes > PRODUCER_QUEUE_MAX_BYTES
    ) {
      const coalescableIndex = queue.findIndex(
        (candidate) => candidate.coalescable,
      );
      if (coalescableIndex < 0) break;
      removeAt(coalescableIndex, true);
    }

    if (
      queue.length >= PRODUCER_QUEUE_MAX_EVENTS ||
      queueBytes + record.bytes > PRODUCER_QUEUE_MAX_BYTES
    ) {
      if (record.coalescable) {
        pressureDropped++;
        note("queue-pressure-current");
        return false;
      }
      const older = queue.splice(0);
      queueBytes = 0;
      coalescedByKey.clear();
      try {
        // Preserve producer order: older queued lifecycle records and the new
        // pressure record must enter the same/later contiguous spool write.
        // Writing only the newest record here would invert segment order.
        spool.writeRecords([...older, record]);
        pressureSpooled += older.length + 1;
        note("queue-pressure-spooled", older.length + 1);
        scheduleReplay();
      } catch {
        // A partial immutable write is harmless on retry (eventId dedup). Keep
        // the bounded older queue; only the record that could not fit is lost.
        queue.push(...older);
        queueBytes = older.reduce((sum, entry) => sum + entry.bytes, 0);
        for (const entry of older) {
          const olderKey = coalescingKey(entry.event);
          if (olderKey) coalescedByKey.set(olderKey, entry);
        }
        pressureDropped++;
        note("queue-pressure-undurable");
        return false;
      }
      return true;
    }

    queue.push(record);
    queueBytes += record.bytes;
    if (key) coalescedByKey.set(key, record);
    if (
      queue.length >= PRODUCER_BATCH_MAX_EVENTS ||
      queueBytes >= PRODUCER_BATCH_MAX_BYTES
    ) {
      void startWorker();
    } else scheduleFlush();
    return true;
  };

  const sink: ProducerObservabilitySink = {
    producerId,
    paths: options.paths,
    config: options.config,
    emit(pending: PendingObservabilityEvent<string>) {
      if (!accepting || normalizing) {
        note(normalizing ? "recursive-emit" : "closed-emit");
        return;
      }
      normalizing = true;
      try {
        const projectRoot = pending?.project?.root;
        const policyMode = contentModeFor(projectRoot);
        if (policyMode === "disabled") {
          normalizedDropped++;
          note("project-disabled");
          return;
        }
        const key = coalescingKey(pending);
        const prior = key ? coalescedByKey.get(key) : undefined;
        if (!prior && producerSeq >= Number.MAX_SAFE_INTEGER) {
          normalizedDropped++;
          note("producer-sequence-exhausted");
          return;
        }
        // A replacement for a still-queued coalescable fact keeps that fact's
        // sequence. Intentional coalescing therefore cannot look like loss at
        // the daemon; a sequence is consumed only when a record is retained.
        const candidateSeq = prior?.event.producer.seq ?? producerSeq + 1;
        const requested = pending?.capture?.contentMode ?? "metadata";
        const mode = minimumContentMode(requested, policyMode);
        const normalized = normalizeProducerEnvelope(
          {
            ...pending,
            producer: { id: producerId, seq: candidateSeq, kind: "pi" },
          },
          { contentMode: mode },
        );
        const retained = queueRecord({
          event: normalized.event,
          serialized: normalized.serialized,
          bytes: normalized.bytes,
          coalescable: COALESCABLE_KINDS.has(normalized.event.kind),
        });
        if (retained) {
          if (!prior) producerSeq = candidateSeq;
          accepted++;
        }
      } catch (error) {
        normalizedDropped++;
        note(
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "normalization-failed",
        );
      } finally {
        normalizing = false;
      }
    },
    async flush(budgetMs: number) {
      const deadline = Date.now() + Math.max(0, Math.floor(budgetMs));
      await Promise.race([
        startWorker(deadline),
        deadlinePromise(deadline),
      ]).catch(() => undefined);
    },
    contentModeFor,
    recordDiagnostic: note,
    async close(budgetMs: number) {
      if (isClosed) return;
      accepting = false;
      if (flushTimer) clearTimeout(flushTimer);
      if (replayTimer) clearTimeout(replayTimer);
      flushTimer = undefined;
      replayTimer = undefined;
      const deadline = Date.now() + Math.max(0, Math.floor(budgetMs));
      // Spool wins over network on shutdown. Any batch already in flight was
      // also spooled before transport submission.
      if (queue.length > 0) {
        const remaining = queue.splice(0);
        queueBytes = 0;
        coalescedByKey.clear();
        try {
          // Bound directory/cap scans by the caller's shutdown deadline. A
          // single already-started filesystem syscall remains uninterruptible,
          // but no new chunk or scan iteration begins after the budget.
          spool.writeRecords(remaining, { deadline });
        } catch (error) {
          pressureDropped += remaining.length;
          note(
            error instanceof Error && error.message === "spool-deadline"
              ? "shutdown-budget-exhausted"
              : "shutdown-spool-failed",
            remaining.length,
          );
        }
      }
      if (worker) {
        await Promise.race([worker, deadlinePromise(deadline)]).catch(
          () => undefined,
        );
      }
      transport.close();
      isClosed = true;
      if (registry().sink === sink) registry().sink = undefined;
    },
    get closed() {
      return isClosed || !accepting;
    },
    get stats() {
      return {
        producerId,
        producerSeq,
        accepted,
        normalizedDropped,
        coalesced,
        pressureDropped,
        pressureSpooled,
        queueEvents: queue.length,
        queueBytes,
        healthTransitions,
        reasons: { ...reasons },
      };
    },
  };

  shared.sink = sink;
  return sink;
}

export function currentProducerSink() {
  const sink = registry().sink;
  return sink && !sink.closed ? sink : undefined;
}

export function resetProducerSinkForTests() {
  const sink = registry().sink;
  if (sink) void sink.close(0);
  registry().sink = undefined;
}
