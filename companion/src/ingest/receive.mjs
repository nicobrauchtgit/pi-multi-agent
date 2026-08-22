import { createStatements } from "../db/statements.mjs";
import { applyProjection } from "../project/apply.mjs";
import { normalizeEvent } from "./normalize.mjs";
import { RequestValidationError } from "./validate.mjs";

export class StorageError extends Error {
  constructor(reason, status = 503) {
    super(reason);
    this.name = "StorageError";
    this.code = reason;
    this.status = status;
  }
}

function numericSqliteCode(error) {
  if (!error || typeof error !== "object") return undefined;
  if (Number.isInteger(error.errcode)) return error.errcode;
  const match = /(?:^|:)(\d+)(?::|$)/.exec(String(error.code ?? ""));
  return match ? Number(match[1]) : undefined;
}

export function classifySqliteError(error) {
  const extended = numericSqliteCode(error);
  if (!Number.isInteger(extended)) return "other";
  if (extended === 1555 || extended === 2067) return "unique-constraint";
  const primary = extended & 0xff;
  if ([5, 6, 10, 13, 14].includes(primary)) return "storage-unavailable";
  return "other";
}

function projectionEvent(normalized, seq, receivedAtMs) {
  return {
    ...normalized,
    seq,
    receivedAtMs,
  };
}

export function receiveBatch(db, rawEvents, nowMs, options = {}) {
  for (const event of rawEvents) {
    if (event && typeof event === "object" && event.v !== 1) {
      throw new RequestValidationError("unsupported-envelope-version", 409);
    }
  }

  const prepared = [];
  const results = new Array(rawEvents.length);
  for (let index = 0; index < rawEvents.length; index++) {
    try {
      prepared.push({
        index,
        event: normalizeEvent(rawEvents[index], {
          policyConfig: options.policyConfig,
        }),
      });
    } catch (error) {
      const reason =
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "invalid-event";
      results[index] = { status: "rejected", reason };
      options.metrics?.reject(reason);
      if (reason === "project-disabled") {
        options.metrics?.increment("projectDisabled");
      }
    }
  }

  const statements = options.statements ?? createStatements(db);
  const deferredMetrics = [];
  const highest = Object.create(null);
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    for (const item of prepared) {
      const event = item.event;
      const existingId = statements.eventById.get(event.eventId);
      if (existingId) {
        if (existingId.payload_sha256 === event.payloadSha256) {
          results[item.index] = {
            eventId: event.eventId,
            status: "duplicate",
            seq: Number(existingId.seq),
          };
          deferredMetrics.push(["duplicate", event]);
          highest[event.producerId] = Math.max(
            highest[event.producerId] ?? -1,
            event.producerSeq,
          );
        } else {
          results[item.index] = {
            eventId: event.eventId,
            status: "conflict",
            reason: "event-id-conflict",
          };
          deferredMetrics.push(["conflict", event]);
        }
        continue;
      }
      const existingProducer = statements.eventByProducer.get(
        event.producerId,
        event.producerSeq,
      );
      if (existingProducer) {
        if (existingProducer.payload_sha256 === event.payloadSha256) {
          results[item.index] = {
            eventId: event.eventId,
            status: "duplicate",
            seq: Number(existingProducer.seq),
          };
          deferredMetrics.push(["duplicate", event]);
          highest[event.producerId] = Math.max(
            highest[event.producerId] ?? -1,
            event.producerSeq,
          );
        } else {
          results[item.index] = {
            eventId: event.eventId,
            status: "conflict",
            reason: "producer-sequence-conflict",
          };
          deferredMetrics.push(["conflict", event]);
        }
        continue;
      }

      // Display-only wall clock. events.seq is the sole receive-order cursor.
      const receivedAtMs = nowMs;
      let inserted;
      try {
        inserted = statements.insertEvent.run(
          event.eventId,
          event.envelopeVersion,
          event.eventKind,
          event.schemaVersion,
          event.producerId,
          event.producerSeq,
          event.producerKind,
          event.occurredAtMs,
          receivedAtMs,
          event.traceId,
          event.runId,
          event.parentRunId,
          event.agentId,
          event.turnId,
          event.toolCallId,
          event.projectId,
          event.payloadJson,
          event.redactionJson,
          event.payloadSha256,
        );
      } catch (error) {
        if (classifySqliteError(error) === "unique-constraint") {
          results[item.index] = {
            eventId: event.eventId,
            status: "conflict",
            reason: "constraint-conflict",
          };
          deferredMetrics.push(["conflict", event]);
          continue;
        }
        throw error;
      }
      const seq = Number(inserted.lastInsertRowid);
      if (options.faultAfterEventInsert === item.index)
        throw new Error("injected-after-event-insert");
      if (event.projects)
        applyProjection(statements, projectionEvent(event, seq, receivedAtMs));
      if (options.faultAfterProjection === item.index)
        throw new Error("injected-after-projection");
      results[item.index] = { eventId: event.eventId, status: "accepted", seq };
      deferredMetrics.push(["accepted", event]);
      highest[event.producerId] = Math.max(
        highest[event.producerId] ?? -1,
        event.producerSeq,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the storage error.
      }
    }
    if (classifySqliteError(error) === "storage-unavailable") {
      throw new StorageError("storage-unavailable", 503);
    }
    throw error;
  }

  for (const [status, event] of deferredMetrics) {
    options.metrics?.increment(status);
    options.metrics?.addRedactions(event.redactionCounts);
    if (event.projectIdMismatch) {
      options.metrics?.increment("projectIdMismatch");
    }
    if (event.policyDowngraded) {
      options.metrics?.increment("policyDowngrades");
    }
    if (event.truncated) options.metrics?.increment("truncations");
  }
  // This is a current missing-sequence gauge, not a historical increment.
  // Late/out-of-order delivery therefore closes an earlier apparent gap.
  options.metrics?.set(
    "producerGaps",
    Number(statements.producerGapCount.get().value),
  );
  options.metrics?.increment("batches");
  const currentSeq = Number(statements.maxSeq.get().value);
  return {
    accepted: results.filter((result) => result?.status === "accepted").length,
    results,
    currentSeq,
    highestAckedProducerSeq: highest,
  };
}
