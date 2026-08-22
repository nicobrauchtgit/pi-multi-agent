import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  REDACTION_MARKERS,
  emptyRedactionCounts,
  encodedStringBytes,
  mergeRedactionCounts,
  redactJson,
  redactString,
} from "../redaction.mjs";

export const OBSERVABILITY_LIMITS = Object.freeze({
  batchBytes: 2 * 1024 * 1024,
  batchEvents: 128,
  storedEventBytes: 512 * 1024,
  envelopeBytes: 128 * 1024,
  contentBytes: 256 * 1024,
  promptBytes: 64 * 1024,
  assistantBytes: 128 * 1024,
  toolArgumentsBytes: 64 * 1024,
  toolResultBytes: 128 * 1024,
  structuredBytes: 256 * 1024,
  metadataStringBytes: 4 * 1024,
  eventIdBytes: 200,
  kindBytes: 200,
  keyBytes: 256,
  depth: 32,
  nodes: 20_000,
  objectKeys: 256,
  arrayItems: 4_096,
});

export const KNOWN_OBSERVABILITY_KINDS = Object.freeze([
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

const KNOWN_KINDS = new Set(KNOWN_OBSERVABILITY_KINDS);
const METADATA_PAYLOAD_KEYS = new Set([
  "agentid",
  "backend",
  "background",
  "classification",
  "contentbytes",
  "contentomitted",
  "displayid",
  "durationms",
  "hasstructuredresult",
  "iserror",
  "label",
  "messagekind",
  "model",
  "modellabel",
  "name",
  "nativesessionid",
  "operation",
  "origin",
  "outcome",
  "partcount",
  "phase",
  "phasecount",
  "provider",
  "reason",
  "resumed",
  "role",
  "runid",
  "runkind",
  "schemaerrorcode",
  "sessionid",
  "stage",
  "status",
  "stopreason",
  "thinkinglevel",
  "thinkingpartcount",
  "textpartcount",
  "toolcallcount",
  "truncated",
  "turnindex",
  "turnnumber",
  "turns",
  "update",
  "workflowagentindex",
  "workflowlabel",
  "workflowphase",
  "workflowrunid",
]);
const STABLE_REDACTION_MARKERS = Object.freeze(
  Object.values(REDACTION_MARKERS),
);
const OMIT = Symbol("omit");

export class SharedNormalizationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SharedNormalizationError";
    this.code = reason;
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

/** UTF-8-safe JSON-string bounding that never leaves a partial redaction marker. */
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
    } else high = middle - 1;
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
      const source = best;
      let prefixLow = 0;
      let prefixHigh = Buffer.byteLength(source, "utf8");
      let prefixBest = "";
      while (prefixLow <= prefixHigh) {
        const middle = Math.floor((prefixLow + prefixHigh) / 2);
        const prefix = utf8Prefix(source, middle);
        if (encodedStringBytes(`${prefix}${suffix}`) <= maximum) {
          prefixBest = prefix;
          prefixLow = middle + 1;
        } else prefixHigh = middle - 1;
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

export function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Reject cycles and hostile JSON shape before recursive redaction. */
export function validateJsonValue(value, limits = OBSERVABILITY_LIMITS) {
  let nodes = 0;
  const ancestors = new Set();
  const visit = (current, depth) => {
    nodes++;
    if (nodes > limits.nodes) throw new SharedNormalizationError("node-limit");
    if (depth > limits.depth) throw new SharedNormalizationError("depth-limit");
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      if (hasLoneSurrogate(current))
        throw new SharedNormalizationError("invalid-unicode");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new SharedNormalizationError("non-finite-number");
      return;
    }
    if (!current || typeof current !== "object") {
      throw new SharedNormalizationError("non-json-value");
    }
    if (ancestors.has(current))
      throw new SharedNormalizationError("cyclic-value");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > limits.arrayItems)
          throw new SharedNormalizationError("array-limit");
        for (const child of current) visit(child, depth + 1);
        return;
      }
      const entries = Object.entries(current);
      if (entries.length > limits.objectKeys)
        throw new SharedNormalizationError("object-key-limit");
      for (const [key, child] of entries) {
        if (
          Buffer.byteLength(key, "utf8") > limits.keyBytes ||
          /[\u0000-\u001f\u007f]/u.test(key) ||
          hasLoneSurrogate(key)
        ) {
          throw new SharedNormalizationError("key-limit");
        }
        visit(child, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };
  visit(value, 0);
  return nodes;
}

export function contentClassification(
  kind,
  path,
  key,
  limits = OBSERVABILITY_LIMITS,
) {
  if (!KNOWN_KINDS.has(kind)) return { content: true, cap: limits.promptBytes };
  const lower = key.toLowerCase();
  if (METADATA_PAYLOAD_KEYS.has(lower)) {
    return { content: false, cap: limits.metadataStringBytes };
  }
  if (lower.includes("structured"))
    return { content: true, cap: limits.structuredBytes };
  if (
    [
      "patch",
      "diff",
      "patchtext",
      "difftext",
      "patchcontent",
      "diffcontent",
    ].includes(lower)
  ) {
    return { content: true, cap: 0, omit: true };
  }
  if (lower.includes("thinking")) {
    return { content: true, cap: limits.assistantBytes };
  }
  if (
    kind === "message.assistant" &&
    ["content", "text", "message"].includes(lower)
  ) {
    return { content: true, cap: limits.assistantBytes };
  }
  if (
    kind === "message.user" &&
    ["content", "text", "message", "prompt"].includes(lower)
  ) {
    return { content: true, cap: limits.promptBytes };
  }
  if (kind === "workflow.log" && path === "payload.message") {
    return { content: true, cap: limits.promptBytes };
  }
  if (kind === "agent.error" && path === "payload.message") {
    return { content: true, cap: limits.promptBytes };
  }
  if (
    (kind === "agent.settled" || kind === "workflow.settled") &&
    ["error", "schemaerror", "finalpreview"].includes(lower)
  ) {
    return {
      content: true,
      cap:
        lower === "finalpreview" ? limits.assistantBytes : limits.promptBytes,
    };
  }
  if (
    kind === "agent.message" &&
    ["content", "text", "message", "thinking"].includes(lower)
  ) {
    return { content: true, cap: limits.assistantBytes };
  }
  if (
    (kind === "tool.started" || kind === "agent.tool_started") &&
    ["arguments", "args", "input"].includes(lower)
  ) {
    return { content: true, cap: limits.toolArgumentsBytes };
  }
  if (
    (kind === "tool.finished" || kind === "agent.tool_finished") &&
    ["result", "output", "content"].includes(lower)
  ) {
    return { content: true, cap: limits.toolResultBytes };
  }
  return { content: true, cap: limits.promptBytes };
}

export function scanAndBoundMetadata(value, maximum, counts) {
  const first = redactString(value);
  mergeRedactionCounts(counts, first.counts);
  const bounded = boundEncodedString(first.value, maximum);
  const second = redactString(bounded.value);
  mergeRedactionCounts(counts, second.counts);
  return {
    ...bounded,
    value: second.value,
    stored: encodedStringBytes(second.value),
  };
}

/** Shared redact -> field/aggregate bound -> complete second scan pipeline. */
export function normalizePayload(
  payload,
  kind,
  contentMode,
  counts = emptyRedactionCounts(),
  limits = OBSERVABILITY_LIMITS,
) {
  validateJsonValue(payload, limits);
  const first = redactJson(payload);
  mergeRedactionCounts(counts, first.counts);
  let remaining = limits.contentBytes;
  const truncatedFields = [];
  const fieldBytes = Object.create(null);

  const note = (path, original, stored) => {
    truncatedFields.push(path);
    fieldBytes[path] = { original, stored };
  };
  const visit = (value, currentPath, key) => {
    if (typeof value === "string") {
      const classification = contentClassification(
        kind,
        currentPath,
        key,
        limits,
      );
      const original = encodedStringBytes(value);
      if (classification.omit) {
        note(currentPath, original, 0);
        return OMIT;
      }
      if (classification.content && contentMode !== "rich") {
        note(currentPath, original, 0);
        return OMIT;
      }
      let maximum = classification.cap;
      if (classification.content) maximum = Math.min(maximum, remaining);
      if (maximum < 2) {
        note(currentPath, original, 0);
        return OMIT;
      }
      const bounded = boundEncodedString(value, maximum);
      if (bounded.truncated)
        note(currentPath, bounded.original, bounded.stored);
      if (classification.content) remaining -= bounded.stored;
      return bounded.value;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        const child = visit(entry, `${currentPath}[${index}]`, String(index));
        return child === OMIT ? null : child;
      });
    }
    if (value && typeof value === "object") {
      const output = Object.create(null);
      for (const [childKey, childValue] of Object.entries(value).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const child = visit(childValue, `${currentPath}.${childKey}`, childKey);
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
  };
}

export function normalizeProducerTruncation(
  capture,
  counts,
  limits = OBSERVABILITY_LIMITS,
) {
  if (capture?.truncated !== true) return null;
  const truncatedFields = [
    ...new Set(
      (capture.truncatedFields ?? []).map(
        (field) =>
          scanAndBoundMetadata(field, limits.metadataStringBytes, counts).value,
      ),
    ),
  ].sort();
  const fieldBytes = Object.create(null);
  for (const [field, sizes] of Object.entries(capture.fieldBytes ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalizedField = scanAndBoundMetadata(
      field,
      limits.metadataStringBytes,
      counts,
    ).value;
    if (Object.hasOwn(fieldBytes, normalizedField)) {
      throw new SharedNormalizationError("capture-field-collision");
    }
    fieldBytes[normalizedField] = {
      original:
        Number.isSafeInteger(sizes?.original) && sizes.original >= 0
          ? sizes.original
          : 0,
      stored:
        Number.isSafeInteger(sizes?.stored) && sizes.stored >= 0
          ? sizes.stored
          : 0,
    };
  }
  return {
    truncated: true,
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
    ...(Object.keys(fieldBytes).length > 0 ? { fieldBytes } : {}),
  };
}

export function sumStringBytes(value) {
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

function opaque(value, reason, maximum) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    hasLoneSurrogate(value)
  ) {
    throw new SharedNormalizationError(reason);
  }
  return value;
}

/** Normalize a producer envelope before it can enter the queue or spool. */
export function normalizeProducerEnvelope(input, options = {}) {
  const limits = options.limits ?? OBSERVABILITY_LIMITS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SharedNormalizationError("event-not-object");
  }
  validateJsonValue(input, limits);
  if (input.v !== 1)
    throw new SharedNormalizationError("unsupported-envelope-version");
  const counts = emptyRedactionCounts();
  const eventId = scanAndBoundMetadata(
    opaque(input.eventId, "invalid-event-id", limits.eventIdBytes),
    limits.eventIdBytes,
    counts,
  ).value;
  const kind = scanAndBoundMetadata(
    opaque(input.kind, "invalid-event-kind", limits.kindBytes),
    limits.kindBytes,
    counts,
  ).value;
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new SharedNormalizationError("invalid-schema-version");
  }
  if (!input.producer || typeof input.producer !== "object") {
    throw new SharedNormalizationError("invalid-producer");
  }
  const producerId = scanAndBoundMetadata(
    opaque(
      input.producer.id,
      "invalid-producer-id",
      limits.metadataStringBytes,
    ),
    limits.metadataStringBytes,
    counts,
  ).value;
  if (!Number.isSafeInteger(input.producer.seq) || input.producer.seq < 0) {
    throw new SharedNormalizationError("invalid-producer-seq");
  }
  const producerKind = scanAndBoundMetadata(
    opaque(input.producer.kind, "invalid-producer-kind", 100),
    100,
    counts,
  ).value;
  const ids = Object.create(null);
  for (const key of [
    "traceId",
    "runId",
    "parentRunId",
    "agentId",
    "turnId",
    "toolCallId",
  ]) {
    const value = input.ids?.[key];
    if (value === undefined || value === null) continue;
    ids[key] = scanAndBoundMetadata(
      opaque(value, `invalid-${key}`, limits.metadataStringBytes),
      limits.metadataStringBytes,
      counts,
    ).value;
  }
  const requestedMode = input.capture?.contentMode;
  if (!["rich", "metadata", "disabled"].includes(requestedMode)) {
    throw new SharedNormalizationError("invalid-content-mode");
  }
  const effectiveMode = options.contentMode ?? requestedMode;
  if (!["rich", "metadata", "disabled"].includes(effectiveMode)) {
    throw new SharedNormalizationError("invalid-effective-content-mode");
  }
  if (
    !input.payload ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    throw new SharedNormalizationError("invalid-payload");
  }
  const normalizedPayload = normalizePayload(
    input.payload,
    kind,
    effectiveMode,
    counts,
    limits,
  );
  const prior = normalizeProducerTruncation(input.capture, counts, limits);
  const truncatedFields = [
    ...new Set([
      ...(prior?.truncatedFields ?? []),
      ...normalizedPayload.truncatedFields,
    ]),
  ].sort();
  const fieldBytes = Object.assign(
    Object.create(null),
    prior?.fieldBytes ?? {},
    normalizedPayload.fieldBytes,
  );
  const capture = {
    contentMode: effectiveMode,
    truncated: truncatedFields.length > 0,
    ...(truncatedFields.length > 0 ? { truncatedFields, fieldBytes } : {}),
  };
  let project;
  if (input.project) {
    const root = scanAndBoundMetadata(
      opaque(
        input.project.root,
        "invalid-project-root",
        limits.metadataStringBytes,
      ),
      limits.metadataStringBytes,
      counts,
    ).value;
    project = {
      root,
      id: `sha256:${createHash("sha256").update(root).digest("hex")}`,
    };
  }
  const occurredAt =
    input.occurredAt === undefined || input.occurredAt === null
      ? undefined
      : Number.isSafeInteger(input.occurredAt)
        ? input.occurredAt
        : (() => {
            throw new SharedNormalizationError("invalid-occurred-at");
          })();
  const envelope = {
    v: 1,
    eventId,
    kind,
    schemaVersion: input.schemaVersion,
    producer: { id: producerId, seq: input.producer.seq, kind: producerKind },
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ids,
    ...(project ? { project } : {}),
    payload: normalizedPayload.payload,
    capture,
  };
  const finalScan = redactJson(envelope);
  mergeRedactionCounts(counts, finalScan.counts);
  const finalEnvelope = canonicalize(finalScan.value);
  const nonContentBytes = Buffer.byteLength(
    canonicalJson({ ...finalEnvelope, payload: {} }),
    "utf8",
  );
  if (nonContentBytes > limits.envelopeBytes) {
    throw new SharedNormalizationError("envelope-limit");
  }
  const serialized = canonicalJson(finalEnvelope);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.storedEventBytes) {
    throw new SharedNormalizationError("stored-event-limit");
  }
  return Object.freeze({
    event: Object.freeze(finalEnvelope),
    serialized,
    bytes,
    redactionCounts: counts,
  });
}

export function isKnownObservabilityKind(kind) {
  return KNOWN_KINDS.has(kind);
}
