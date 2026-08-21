import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  REDACTION_MARKERS,
  REDACTION_RULES_VERSION,
  emptyRedactionCounts,
  encodedStringBytes,
  mergeRedactionCounts,
  redactJson,
  redactString,
} from "../../../extensions/shared/redaction.mjs";
import { LIMITS } from "../constants.mjs";
import { EventValidationError, validateEvent } from "./validate.mjs";

const KNOWN_KINDS = new Set([
  "run.started",
  "turn.started",
  "message.user",
  "message.assistant",
  "tool.started",
  "tool.finished",
  "turn.settled",
  "run.settled",
  "session.compacted",
  "agent.created",
  "agent.run_started",
  "agent.message",
  "agent.tool_started",
  "agent.tool_finished",
  "agent.usage",
  "agent.meta",
  "agent.error",
  "agent.settled",
  "workflow.started",
  "workflow.phase",
  "workflow.log",
  "workflow.settled",
  "artifact.observed",
  "artifact.recovered",
  "telemetry.dropped",
  "telemetry.spool_overflow",
  "telemetry.rejected",
]);

const NON_PROJECTING_KINDS = new Set([
  "artifact.observed",
  "artifact.recovered",
  "telemetry.dropped",
  "telemetry.spool_overflow",
  "telemetry.rejected",
]);

const METADATA_PAYLOAD_KEYS = new Set([
  "agentid",
  "backend",
  "displayid",
  "label",
  "messagekind",
  "model",
  "modellabel",
  "name",
  "nativeSessionId".toLowerCase(),
  "origin",
  "outcome",
  "phase",
  "role",
  "runid",
  "schemaerrorcode",
  "sessionid",
  "stage",
  "status",
  "title",
  "update",
  "workflowlabel",
  "workflowphase",
  "workflowrunid",
]);

const OMIT = Symbol("omit");
const STABLE_REDACTION_MARKERS = Object.freeze(
  Object.values(REDACTION_MARKERS),
);

export class NormalizationError extends EventValidationError {
  constructor(reason) {
    super(reason);
    this.name = "NormalizationError";
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort())
      output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function utf8Prefix(value, rawBytes) {
  const buffer = Buffer.from(value, "utf8");
  if (rawBytes >= buffer.length) return value;
  let end = Math.max(0, rawBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function boundEncodedString(value, maximum) {
  const original = encodedStringBytes(value);
  if (original <= maximum)
    return { value, original, stored: original, truncated: false };
  let low = 0;
  let high = Buffer.byteLength(value, "utf8");
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(value, middle);
    if (encodedStringBytes(candidate) <= maximum) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const missingMarkers = STABLE_REDACTION_MARKERS.filter(
    (marker) => value.includes(marker) && !best.includes(marker),
  );
  if (missingMarkers.length > 0) {
    const partialMarker = best.lastIndexOf("[REDACTED:");
    if (partialMarker >= 0 && best.indexOf("]", partialMarker) < 0) {
      best = best.slice(0, partialMarker);
    }
    const suffix = missingMarkers.join("");
    if (encodedStringBytes(suffix) <= maximum) {
      const prefixSource = best;
      let prefixLow = 0;
      let prefixHigh = Buffer.byteLength(prefixSource, "utf8");
      let prefixBest = "";
      while (prefixLow <= prefixHigh) {
        const middle = Math.floor((prefixLow + prefixHigh) / 2);
        const prefix = utf8Prefix(prefixSource, middle);
        if (encodedStringBytes(`${prefix}${suffix}`) <= maximum) {
          prefixBest = prefix;
          prefixLow = middle + 1;
        } else {
          prefixHigh = middle - 1;
        }
      }
      best = `${prefixBest}${suffix}`;
    }
  }
  return {
    value: best,
    original,
    stored: encodedStringBytes(best),
    truncated: true,
  };
}

function contentClassification(kind, path, key) {
  if (!KNOWN_KINDS.has(kind)) return { content: true, cap: LIMITS.promptBytes };
  const lower = key.toLowerCase();
  if (lower.includes("structured"))
    return { content: true, cap: LIMITS.structuredBytes };
  if (lower.includes("patch") || lower.includes("diff"))
    return { content: true, cap: LIMITS.structuredBytes };
  if (kind === "message.assistant" || lower.includes("thinking")) {
    return { content: true, cap: LIMITS.assistantBytes };
  }
  if (kind === "message.user")
    return { content: true, cap: LIMITS.promptBytes };
  if (kind === "workflow.log" && path === "payload.message")
    return { content: true, cap: LIMITS.promptBytes };
  if (kind === "agent.error" && path === "payload.message")
    return { content: true, cap: LIMITS.promptBytes };
  if (
    (kind === "agent.settled" || kind === "workflow.settled") &&
    ["error", "schemaerror", "finalpreview"].includes(lower)
  ) {
    return {
      content: true,
      cap:
        lower === "finalpreview" ? LIMITS.assistantBytes : LIMITS.promptBytes,
    };
  }
  if (
    kind === "agent.message" &&
    ["content", "text", "message", "thinking"].includes(lower)
  ) {
    return {
      content: true,
      cap: lower === "thinking" ? LIMITS.assistantBytes : LIMITS.assistantBytes,
    };
  }
  if (
    (kind === "tool.started" || kind === "agent.tool_started") &&
    ["arguments", "args", "input"].includes(lower)
  ) {
    return { content: true, cap: LIMITS.toolArgumentsBytes };
  }
  if (
    (kind === "tool.finished" || kind === "agent.tool_finished") &&
    ["result", "output", "content"].includes(lower)
  ) {
    return { content: true, cap: LIMITS.toolResultBytes };
  }
  if (METADATA_PAYLOAD_KEYS.has(lower)) {
    return { content: false, cap: LIMITS.metadataStringBytes };
  }
  // Additive string fields default to content, not metadata, so a future rich
  // field cannot bypass aggregate budgets or metadata-mode omission merely by
  // using a key this binary does not recognize.
  return { content: true, cap: LIMITS.promptBytes };
}

function scanAndBoundMetadata(value, maximum, counts) {
  const first = redactString(value);
  mergeRedactionCounts(counts, first.counts);
  const bounded = boundEncodedString(first.value, maximum);
  const second = redactString(bounded.value);
  mergeRedactionCounts(counts, second.counts);
  return { ...bounded, value: second.value };
}

function normalizePayload(payload, kind, contentMode, counts) {
  const first = redactJson(payload);
  mergeRedactionCounts(counts, first.counts);
  let remaining = LIMITS.contentBytes;
  const truncatedFields = [];
  const fieldBytes = Object.create(null);
  let contentStoredBytes = 0;

  const note = (path, original, stored) => {
    truncatedFields.push(path);
    fieldBytes[path] = { original, stored };
  };

  const visit = (value, path, key) => {
    if (typeof value === "string") {
      const classification = contentClassification(kind, path, key);
      const original = encodedStringBytes(value);
      if (
        classification.content &&
        (contentMode === "metadata" || contentMode === "disabled")
      ) {
        note(path, original, 0);
        return OMIT;
      }
      let maximum = classification.cap;
      if (classification.content) maximum = Math.min(maximum, remaining);
      if (maximum < 2) {
        note(path, original, 0);
        return OMIT;
      }
      const bounded = boundEncodedString(value, maximum);
      if (bounded.truncated) note(path, bounded.original, bounded.stored);
      if (classification.content) {
        remaining -= bounded.stored;
        contentStoredBytes += bounded.stored;
      }
      return bounded.value;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        const child = visit(entry, `${path}[${index}]`, String(index));
        return child === OMIT ? null : child;
      });
    }
    if (value && typeof value === "object") {
      const output = Object.create(null);
      for (const [childKey, childValue] of Object.entries(value).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const childPath = `${path}.${childKey}`;
        const child = visit(childValue, childPath, childKey);
        if (child !== OMIT) output[childKey] = child;
      }
      return output;
    }
    return value;
  };

  const bounded = visit(first.value, "payload", "payload");
  const second = redactJson(bounded);
  mergeRedactionCounts(counts, second.counts);
  return {
    payload: second.value,
    truncatedFields,
    fieldBytes,
    contentStoredBytes,
  };
}

function normalizeOptional(value, maximum, counts) {
  if (value === undefined || value === null) return null;
  return scanAndBoundMetadata(value, maximum, counts).value;
}

function normalizeProducerTruncation(capture, counts) {
  if (capture.truncated !== true) return null;
  const truncatedFields = [
    ...new Set(
      (capture.truncatedFields ?? []).map(
        (field) =>
          scanAndBoundMetadata(field, LIMITS.metadataStringBytes, counts).value,
      ),
    ),
  ].sort();
  const fieldBytes = Object.create(null);
  for (const [field, sizes] of Object.entries(capture.fieldBytes ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalizedField = scanAndBoundMetadata(
      field,
      LIMITS.metadataStringBytes,
      counts,
    ).value;
    if (Object.hasOwn(fieldBytes, normalizedField)) {
      throw new NormalizationError("capture-field-collision");
    }
    fieldBytes[normalizedField] = {
      original: sizes.original,
      stored: sizes.stored,
    };
  }
  return {
    truncated: true,
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
    ...(Object.keys(fieldBytes).length > 0 ? { fieldBytes } : {}),
  };
}

export function normalizeEvent(input) {
  const event = validateEvent(input);
  const counts = emptyRedactionCounts();
  const eventId = scanAndBoundMetadata(
    event.eventId,
    LIMITS.eventIdBytes,
    counts,
  ).value;
  const kind = scanAndBoundMetadata(event.kind, LIMITS.kindBytes, counts).value;
  const producerId = scanAndBoundMetadata(
    event.producer.id,
    LIMITS.metadataStringBytes,
    counts,
  ).value;
  const producerKind = scanAndBoundMetadata(
    event.producer.kind,
    100,
    counts,
  ).value;
  const traceId = normalizeOptional(
    event.ids.traceId,
    LIMITS.metadataStringBytes,
    counts,
  );
  const runId = normalizeOptional(
    event.ids.runId,
    LIMITS.metadataStringBytes,
    counts,
  );
  const parentRunId = normalizeOptional(
    event.ids.parentRunId,
    LIMITS.metadataStringBytes,
    counts,
  );
  const agentId = normalizeOptional(
    event.ids.agentId,
    LIMITS.metadataStringBytes,
    counts,
  );
  const turnId = normalizeOptional(
    event.ids.turnId,
    LIMITS.metadataStringBytes,
    counts,
  );
  const toolCallId = normalizeOptional(
    event.ids.toolCallId,
    LIMITS.metadataStringBytes,
    counts,
  );
  const contentMode = event.capture.contentMode;
  const normalizedPayload = normalizePayload(
    event.payload,
    kind,
    contentMode,
    counts,
  );
  const producerTruncation = normalizeProducerTruncation(event.capture, counts);

  /** @type {{ id: string, root: string } | null} */
  let project = null;
  let projectIdMismatch = false;
  if (event.project) {
    const root = scanAndBoundMetadata(
      event.project.root,
      LIMITS.metadataStringBytes,
      counts,
    ).value;
    const suppliedId = scanAndBoundMetadata(
      event.project.id,
      LIMITS.metadataStringBytes,
      counts,
    ).value;
    const id = `sha256:${createHash("sha256").update(root).digest("hex")}`;
    projectIdMismatch = suppliedId !== id;
    project = { id, root };
  }

  const daemonTruncated = normalizedPayload.truncatedFields.length > 0;
  const capture = {
    contentMode,
    truncated: Boolean(producerTruncation || daemonTruncated),
    ...(producerTruncation ? { producerTruncation } : {}),
    ...(daemonTruncated
      ? {
          daemonTruncation: {
            truncated: true,
            truncatedFields: normalizedPayload.truncatedFields,
            fieldBytes: normalizedPayload.fieldBytes,
          },
        }
      : {}),
  };
  const storedPayload = canonicalize({
    payload: normalizedPayload.payload,
    capture,
    ...(project ? { project } : {}),
  });
  const payloadJson = canonicalJson(storedPayload);
  const redaction = canonicalize({
    rulesVersion: REDACTION_RULES_VERSION,
    counts: Object.fromEntries(
      Object.entries(counts).filter(([, count]) => count > 0),
    ),
    policy: { contentMode },
    ...(projectIdMismatch ? { projectIdMismatch: true } : {}),
  });
  const redactionJson = canonicalJson(redaction);
  const payloadSha256 = createHash("sha256")
    .update(
      canonicalJson({
        eventId,
        envelopeVersion: 1,
        eventKind: kind,
        schemaVersion: event.schemaVersion,
        producerId,
        producerSeq: event.producer.seq,
        producerKind,
        occurredAtMs: event.occurredAt ?? null,
        traceId,
        runId,
        parentRunId,
        agentId,
        turnId,
        toolCallId,
        projectId: project?.id ?? null,
        payloadJson,
        redactionJson,
      }),
    )
    .digest("hex");

  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const payloadStringBytes = sumStringBytes(normalizedPayload.payload);
  const structuralPayloadBytes = Math.max(0, payloadBytes - payloadStringBytes);
  const storedMetadata = {
    v: 1,
    eventId,
    kind,
    schemaVersion: event.schemaVersion,
    producer: { id: producerId, seq: event.producer.seq, kind: producerKind },
    occurredAt: event.occurredAt ?? null,
    ids: { traceId, runId, parentRunId, agentId, turnId, toolCallId },
    projectId: project?.id ?? null,
    redaction,
  };
  const metadataBytes =
    Buffer.byteLength(canonicalJson(storedMetadata), "utf8") +
    structuralPayloadBytes;
  if (metadataBytes > LIMITS.envelopeBytes)
    throw new NormalizationError("envelope-limit");
  const totalBytes = metadataBytes + payloadStringBytes;
  if (totalBytes > LIMITS.storedEventBytes)
    throw new NormalizationError("stored-event-limit");

  return Object.freeze({
    eventId,
    envelopeVersion: 1,
    eventKind: kind,
    schemaVersion: event.schemaVersion,
    producerId,
    producerSeq: event.producer.seq,
    producerKind,
    occurredAtMs: event.occurredAt ?? null,
    traceId,
    runId,
    parentRunId,
    agentId,
    turnId,
    toolCallId,
    projectId: project?.id ?? null,
    projectRoot: project?.root ?? null,
    payload: normalizedPayload.payload,
    capture,
    payloadJson,
    redactionJson,
    payloadSha256,
    redactionCounts: counts,
    projectIdMismatch,
    truncated: capture.truncated,
    knownKind: KNOWN_KINDS.has(kind),
    projects: !NON_PROJECTING_KINDS.has(kind),
  });
}

function sumStringBytes(value) {
  if (typeof value === "string") return encodedStringBytes(value);
  if (Array.isArray(value))
    return value.reduce((total, child) => total + sumStringBytes(child), 0);
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (total, child) => total + sumStringBytes(child),
      0,
    );
  }
  return 0;
}

export function isKnownKind(kind) {
  return KNOWN_KINDS.has(kind);
}
