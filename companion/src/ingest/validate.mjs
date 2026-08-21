import { Buffer } from "node:buffer";
import { LIMITS } from "../constants.mjs";

export class RequestValidationError extends Error {
  constructor(reason, status = 400) {
    super(reason);
    this.name = "RequestValidationError";
    this.code = reason;
    this.status = status;
  }
}

export class EventValidationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "EventValidationError";
    this.code = reason;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonBytes(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new EventValidationError("not-json");
  return Buffer.byteLength(serialized, "utf8");
}

function assertInteger(value, reason, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new EventValidationError(reason);
  }
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertOpaque(value, reason, maximum = LIMITS.metadataStringBytes) {
  if (typeof value !== "string" || value.length === 0) {
    throw new EventValidationError(reason);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    hasLoneSurrogate(value)
  ) {
    throw new EventValidationError(reason);
  }
}

function assertOptionalOpaque(value, reason) {
  if (value !== undefined && value !== null) assertOpaque(value, reason);
}

export function validateJsonShape(value) {
  let nodes = 0;
  const visit = (current, depth) => {
    nodes++;
    if (nodes > LIMITS.nodes) throw new EventValidationError("node-limit");
    if (depth > LIMITS.depth) throw new EventValidationError("depth-limit");
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      if (hasLoneSurrogate(current))
        throw new EventValidationError("invalid-unicode");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new EventValidationError("non-finite-number");
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > LIMITS.arrayItems)
        throw new EventValidationError("array-limit");
      for (const child of current) visit(child, depth + 1);
      return;
    }
    if (!isRecord(current)) throw new EventValidationError("non-json-value");
    const entries = Object.entries(current);
    if (entries.length > LIMITS.objectKeys)
      throw new EventValidationError("object-key-limit");
    for (const [key, child] of entries) {
      if (
        Buffer.byteLength(key, "utf8") > LIMITS.keyBytes ||
        /[\u0000-\u001f\u007f]/u.test(key) ||
        hasLoneSurrogate(key)
      ) {
        throw new EventValidationError("key-limit");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return nodes;
}

export function parseBatch(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestValidationError("invalid-json", 400);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
    throw new RequestValidationError("invalid-batch", 400);
  }
  if (parsed.v !== 1)
    throw new RequestValidationError("unsupported-envelope-version", 409);
  if (parsed.events.length > LIMITS.batchEvents) {
    throw new RequestValidationError("batch-event-limit", 413);
  }
  for (const event of parsed.events) {
    if (isRecord(event) && event.v !== 1) {
      throw new RequestValidationError("unsupported-envelope-version", 409);
    }
  }
  return parsed.events;
}

export function validateEvent(event) {
  if (!isRecord(event)) throw new EventValidationError("event-not-object");
  validateJsonShape(event);
  if (event.v !== 1)
    throw new EventValidationError("unsupported-envelope-version");
  assertOpaque(event.eventId, "invalid-event-id", LIMITS.eventIdBytes);
  assertOpaque(event.kind, "invalid-event-kind", LIMITS.kindBytes);
  assertInteger(event.schemaVersion, "invalid-schema-version", 1);
  if (event.occurredAt !== undefined && event.occurredAt !== null) {
    assertInteger(event.occurredAt, "invalid-occurred-at");
  }
  if (!isRecord(event.producer))
    throw new EventValidationError("invalid-producer");
  assertOpaque(event.producer.id, "invalid-producer-id");
  assertInteger(event.producer.seq, "invalid-producer-seq", 0);
  assertOpaque(event.producer.kind, "invalid-producer-kind", 100);

  if (!isRecord(event.ids)) throw new EventValidationError("invalid-ids");
  for (const key of [
    "traceId",
    "runId",
    "parentRunId",
    "agentId",
    "turnId",
    "toolCallId",
  ]) {
    assertOptionalOpaque(event.ids[key], `invalid-${key}`);
  }
  if (!isRecord(event.payload))
    throw new EventValidationError("invalid-payload");
  if (!isRecord(event.capture))
    throw new EventValidationError("invalid-capture");
  if (!["rich", "metadata", "disabled"].includes(event.capture.contentMode)) {
    throw new EventValidationError("invalid-content-mode");
  }
  if (typeof event.capture.truncated !== "boolean") {
    throw new EventValidationError("invalid-capture-truncated");
  }
  if (event.capture.truncatedFields !== undefined) {
    if (
      !Array.isArray(event.capture.truncatedFields) ||
      event.capture.truncatedFields.length > LIMITS.objectKeys
    ) {
      throw new EventValidationError("invalid-truncated-fields");
    }
    for (const field of event.capture.truncatedFields) {
      assertOpaque(field, "invalid-truncated-field");
    }
  }
  if (event.capture.fieldBytes !== undefined) {
    if (!isRecord(event.capture.fieldBytes)) {
      throw new EventValidationError("invalid-field-bytes");
    }
    for (const [field, sizes] of Object.entries(event.capture.fieldBytes)) {
      assertOpaque(field, "invalid-field-byte-path");
      if (!isRecord(sizes))
        throw new EventValidationError("invalid-field-byte-value");
      assertInteger(sizes.original, "invalid-field-byte-original", 0);
      assertInteger(sizes.stored, "invalid-field-byte-stored", 0);
    }
  }
  if (event.project !== undefined) {
    if (!isRecord(event.project))
      throw new EventValidationError("invalid-project");
    assertOpaque(event.project.id, "invalid-project-id");
    assertOpaque(event.project.root, "invalid-project-root");
  }

  const { payload: _payload, ...nonContent } = event;
  if (jsonBytes(nonContent) > LIMITS.envelopeBytes) {
    throw new EventValidationError("envelope-limit");
  }
  return event;
}
