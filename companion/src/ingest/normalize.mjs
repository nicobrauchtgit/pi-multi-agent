import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  REDACTION_RULES_VERSION,
  emptyRedactionCounts,
} from "../../../extensions/shared/redaction.mjs";
import {
  canonicalize,
  canonicalJson,
  normalizePayload,
  normalizeProducerTruncation,
  scanAndBoundMetadata,
  sumStringBytes,
} from "../../../extensions/shared/observability/normalize.mjs";
import {
  canonicalizePath,
  minimumContentMode,
  resolveProjectPolicy,
} from "../../../extensions/shared/observability/policy.mjs";
import { LIMITS } from "../constants.mjs";
import { EventValidationError, validateEvent } from "./validate.mjs";

const NON_PROJECTING_KINDS = new Set([
  "artifact.observed",
  "artifact.recovered",
  "telemetry.dropped",
  "telemetry.spool_overflow",
  "telemetry.rejected",
]);

export class NormalizationError extends EventValidationError {
  constructor(reason) {
    super(reason);
    this.name = "NormalizationError";
  }
}

function normalizeOptional(value, maximum, counts) {
  if (value === undefined || value === null) return null;
  return scanAndBoundMetadata(value, maximum, counts).value;
}

export function normalizeEvent(input, options = {}) {
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

  /** @type {{ id: string, root: string } | null} */
  let project = null;
  let projectIdMismatch = false;
  if (event.project) {
    let canonicalRoot = event.project.root;
    if (options.policyConfig) {
      try {
        canonicalRoot = canonicalizePath(event.project.root);
      } catch {
        throw new NormalizationError("invalid-project-root");
      }
    }
    const root = scanAndBoundMetadata(
      canonicalRoot,
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

  const producerContentMode = event.capture.contentMode;
  let configuredContentMode = producerContentMode;
  /** @type {"rich" | "metadata" | "disabled"} */
  let daemonContentCeiling = "rich";
  let policySource = "producer";
  if (options.policyConfig) {
    const policy = resolveProjectPolicy(
      options.policyConfig,
      project?.root ?? undefined,
    );
    if (!policy.enabled) throw new NormalizationError("project-disabled");
    configuredContentMode = policy.contentMode;
    // Rich capture is process-wide unavailable in D2. Keep the parser's
    // policy-free rich mode for isolated normalization tests, but production
    // daemon policy can opt in only after the same backend boundary gate.
    daemonContentCeiling = options.richAllowed === true ? "rich" : "metadata";
    policySource = policy.policySource;
  }
  let contentMode = minimumContentMode(
    producerContentMode,
    configuredContentMode,
    daemonContentCeiling,
  );
  if (projectIdMismatch && options.policyConfig) {
    contentMode = minimumContentMode(contentMode, "metadata");
  }

  const normalizedPayload = normalizePayload(
    event.payload,
    kind,
    contentMode,
    counts,
    LIMITS,
  );
  const producerTruncation = normalizeProducerTruncation(
    event.capture,
    counts,
    LIMITS,
  );
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
    policy: {
      contentMode,
      producerContentMode,
      configuredContentMode,
      ...(options.policyConfig
        ? { daemonRichCaptureAllowed: options.richAllowed === true }
        : {}),
      policySource: options.policyConfig
        ? `daemon:${policySource}`
        : policySource,
    },
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
  if (metadataBytes > LIMITS.envelopeBytes) {
    throw new NormalizationError("envelope-limit");
  }
  const totalBytes = metadataBytes + payloadStringBytes;
  if (totalBytes > LIMITS.storedEventBytes) {
    throw new NormalizationError("stored-event-limit");
  }

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
    policyDowngraded: contentMode !== producerContentMode,
    truncated: capture.truncated,
    projects: !NON_PROJECTING_KINDS.has(kind),
  });
}

export { canonicalize, canonicalJson };
export { boundEncodedString } from "../../../extensions/shared/observability/normalize.mjs";
