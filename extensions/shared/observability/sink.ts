import { Context, Layer } from "effect";
import {
  STORED_EVENT_MAX_BYTES,
  estimateEventBytes,
  type ObservabilityEvent,
  type PendingObservabilityEvent,
} from "./events.ts";
import { mintProducerId, type ProducerId } from "./ids.ts";

/**
 * Read-side boundary only. Implementations must return synchronously from emit,
 * never throw, and must not call back into manager/workflow lifecycle code.
 */
export interface ObservabilitySink {
  emit(event: PendingObservabilityEvent<string>): void;
  flush(budgetMs: number): Promise<void>;
}

export const NOOP_OBSERVABILITY_SINK: ObservabilitySink = Object.freeze({
  emit: (_event: PendingObservabilityEvent<string>) => undefined,
  flush: async (_budgetMs: number) => undefined,
});

/** Defense-in-depth for hostile or faulty implementations of the contract. */
export function safeEmit(
  sink: ObservabilitySink,
  event: PendingObservabilityEvent<string>,
): void {
  try {
    sink.emit(event);
  } catch {
    // Observability can never feed an error back into orchestration.
  }
}

export class ObservabilitySinkService extends Context.Service<
  ObservabilitySinkService,
  ObservabilitySink
>()("multi-agent/ObservabilitySink") {}

export const NoopObservabilitySinkLayer = Layer.succeed(
  ObservabilitySinkService,
  NOOP_OBSERVABILITY_SINK,
);

export type RecordingDropReason = "invalid" | "event-too-large" | "capacity";

export interface RecordingSinkStats {
  readonly accepted: number;
  readonly dropped: number;
  readonly currentBytes: number;
  readonly droppedByReason: Readonly<Record<RecordingDropReason, number>>;
}

export interface RecordingObservabilitySink extends ObservabilitySink {
  readonly producerId: ProducerId;
  readonly events: ReadonlyArray<ObservabilityEvent>;
  readonly stats: RecordingSinkStats;
  clear(): void;
}

export function createRecordingSink(
  options: {
    readonly maxEvents?: number;
    readonly maxBytes?: number;
    readonly producerId?: ProducerId;
  } = {},
): RecordingObservabilitySink {
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? 1_000));
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  const producerId = options.producerId ?? mintProducerId();
  const recorded: ObservabilityEvent[] = [];
  const recordedBytes: number[] = [];
  const droppedByReason: Record<RecordingDropReason, number> = {
    invalid: 0,
    "event-too-large": 0,
    capacity: 0,
  };
  let producerSeq = 0;
  let accepted = 0;
  let dropped = 0;
  let currentBytes = 0;

  const drop = (reason: RecordingDropReason) => {
    dropped++;
    droppedByReason[reason]++;
  };

  const sink: RecordingObservabilitySink = {
    producerId,
    emit: (pending) => {
      // Every attempted production consumes a sequence, including records
      // dropped locally, so the next accepted event exposes a detectable gap.
      producerSeq++;
      try {
        const candidate = {
          ...pending,
          producer: {
            id: producerId,
            seq: producerSeq,
            kind: "pi" as const,
          },
        } as ObservabilityEvent;
        const bytes = estimateEventBytes(candidate);
        if (!Number.isFinite(bytes)) {
          drop("invalid");
          return;
        }
        if (bytes > STORED_EVENT_MAX_BYTES || bytes > maxBytes) {
          drop("event-too-large");
          return;
        }
        while (
          recorded.length > 0 &&
          (recorded.length >= maxEvents || currentBytes + bytes > maxBytes)
        ) {
          recorded.shift();
          currentBytes -= recordedBytes.shift() ?? 0;
          drop("capacity");
        }
        if (maxEvents === 0 || recorded.length >= maxEvents) {
          drop("capacity");
          return;
        }
        recorded.push(candidate);
        recordedBytes.push(bytes);
        currentBytes += bytes;
        accepted++;
      } catch {
        drop("invalid");
      }
    },
    flush: async (_budgetMs) => undefined,
    get events() {
      return recorded;
    },
    get stats() {
      return {
        accepted,
        dropped,
        currentBytes,
        droppedByReason: { ...droppedByReason },
      };
    },
    clear: () => {
      recorded.length = 0;
      recordedBytes.length = 0;
      producerSeq = 0;
      accepted = 0;
      dropped = 0;
      currentBytes = 0;
      droppedByReason.invalid = 0;
      droppedByReason["event-too-large"] = 0;
      droppedByReason.capacity = 0;
    },
  };
  return sink;
}
