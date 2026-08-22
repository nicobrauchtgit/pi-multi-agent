import * as fs from "node:fs";
import {
  BUILD_VERSION,
  PROTOCOL_VERSION,
  READ_LIMITS,
  SCHEMA_VERSION,
} from "../constants.mjs";
import { HttpError } from "./auth.mjs";

const RUN_STATUSES = new Set([
  "running",
  "completed",
  "failed",
  "aborted",
  "unknown",
]);
const RUN_KINDS = new Set(["workflow", "standalone", "session", "unknown"]);
const STATUS_COUNTER_KEYS = Object.freeze([
  "accepted",
  "duplicate",
  "conflict",
  "rejected",
  "batches",
  "truncations",
  "projectIdMismatch",
  "projectDisabled",
  "policyDowngrades",
  "producerGaps",
  "spoolSegmentsReplayed",
  "spoolRecordsReplayed",
  "spoolPartialTails",
  "spoolMalformed",
]);
const RESPONSE_DATA_BUDGET = READ_LIMITS.responseBytes - 64 * 1024;
const STORED_OBJECT_BUDGET = READ_LIMITS.eventPageBytes - 64 * 1024;

/** @returns {never} */
function badRequest(code = "invalid-query") {
  throw new HttpError(400, code);
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function parseOpaqueId(value, code = "invalid-id") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > READ_LIMITS.opaqueIdBytes ||
    /[\u0000-\u001f\u007f\ufffd]/u.test(value) ||
    hasLoneSurrogate(value)
  ) {
    badRequest(code);
  }
  return value;
}

function decodePathId(value, code) {
  try {
    return parseOpaqueId(decodeURIComponent(value), code);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    badRequest(code);
  }
}

function parseInteger(value, options) {
  if (value === undefined) return options.defaultValue;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) badRequest(options.code);
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < options.minimum ||
    parsed > options.maximum
  ) {
    badRequest(options.code);
  }
  return parsed;
}

export function parseStrictQuery(searchParams, specification) {
  const entries = [...searchParams.entries()];
  if (entries.length > READ_LIMITS.queryParameters) badRequest();
  const output = {};
  const seen = new Set();
  for (const [key, value] of entries) {
    if (!Object.hasOwn(specification, key) || seen.has(key)) badRequest();
    seen.add(key);
    output[key] = specification[key](value);
  }
  return output;
}

function queryUrl(request) {
  if (
    typeof request.url !== "string" ||
    Buffer.byteLength(request.url, "utf8") > READ_LIMITS.queryBytes
  ) {
    badRequest("request-target-too-large");
  }
  try {
    return new URL(request.url, "http://127.0.0.1");
  } catch {
    badRequest("invalid-request-target");
  }
}

function safeStoredObject(value, budget = STORED_OBJECT_BUDGET) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > budget) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? value : null;
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return null;
}

function runSummary(row, counts = undefined) {
  return {
    runId: row.run_id,
    traceId: row.trace_id,
    parentRunId: row.parent_run_id,
    runKind: row.run_kind,
    projectId: row.project_id,
    projectRoot: row.project_root,
    sessionId: row.session_id,
    name: row.name,
    currentPhase: row.current_phase,
    status: row.status,
    startedAtMs: numberOrNull(row.started_at_ms),
    settledAtMs: numberOrNull(row.settled_at_ms),
    errorText: row.error_text,
    recoveredFromArtifact: numberOrNull(row.recovered_from_artifact) === 1,
    contentMode: row.content_mode,
    lastSeq: numberOrNull(row.last_seq),
    metadata: safeStoredObject(row.metadata_json),
    ...(counts ? { agentCounts: counts } : {}),
  };
}

function agentSummary(row) {
  return {
    agentId: row.agent_id,
    runId: row.run_id,
    localId: row.local_id,
    workflowIndex: numberOrNull(row.workflow_index),
    origin: row.origin,
    backend: row.backend,
    role: row.role,
    title: row.title,
    cwd: row.cwd,
    model: row.model,
    nativeSessionId: row.native_session_id,
    status: row.status,
    currentTurnId: row.current_turn_id,
    startedAtMs: numberOrNull(row.started_at_ms),
    settledAtMs: numberOrNull(row.settled_at_ms),
    errorText: row.error_text,
    finalPreview: row.final_preview,
    lastSeq: numberOrNull(row.last_seq),
    metadata: safeStoredObject(row.metadata_json),
  };
}

function eventRecord(row) {
  const storedBytes =
    (typeof row.payload_json === "string"
      ? Buffer.byteLength(row.payload_json, "utf8")
      : Infinity) +
    (typeof row.redaction_json === "string"
      ? Buffer.byteLength(row.redaction_json, "utf8")
      : Infinity);
  const storedPayload =
    storedBytes <= STORED_OBJECT_BUDGET
      ? safeStoredObject(row.payload_json)
      : null;
  const redaction =
    storedBytes <= STORED_OBJECT_BUDGET
      ? safeStoredObject(row.redaction_json)
      : null;
  const capture =
    storedPayload &&
    storedPayload.capture &&
    typeof storedPayload.capture === "object" &&
    !Array.isArray(storedPayload.capture)
      ? storedPayload.capture
      : null;
  const unavailable = !storedPayload || !capture || !redaction;
  const record = {
    seq: numberOrNull(row.seq),
    eventId: row.event_id,
    kind: row.event_kind,
    schemaVersion: numberOrNull(row.schema_version),
    producer: {
      id: row.producer_id,
      seq: numberOrNull(row.producer_seq),
      kind: row.producer_kind,
    },
    occurredAtMs: numberOrNull(row.occurred_at_ms),
    receivedAtMs: numberOrNull(row.received_at_ms),
    ids: {
      traceId: row.trace_id,
      runId: row.run_id,
      parentRunId: row.parent_run_id,
      agentId: row.agent_id,
      turnId: row.turn_id,
      toolCallId: row.tool_call_id,
    },
    projectId: row.project_id,
    payload: unavailable ? null : (storedPayload.payload ?? null),
    capture: unavailable
      ? {
          contentMode: capture?.contentMode ?? "metadata",
          truncated: capture?.truncated === true,
          unavailable: true,
        }
      : capture,
    redaction: unavailable ? null : redaction,
  };
  if (encodedBytes(record) <= STORED_OBJECT_BUDGET) return record;
  return {
    ...record,
    payload: null,
    capture: {
      contentMode: capture?.contentMode ?? "metadata",
      truncated: capture?.truncated === true,
      unavailable: true,
    },
    redaction: null,
  };
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function takeWithinBudget(values, budget = RESPONSE_DATA_BUDGET) {
  const output = [];
  let bytes = 0;
  for (const value of values) {
    const next = encodedBytes(value);
    if (output.length > 0 && bytes + next > budget) break;
    output.push(value);
    bytes += next;
  }
  return output;
}

function watermarks(statements) {
  const retainedMax = Math.max(
    0,
    numberOrNull(statements.maxRetainedSeq.get().value) ?? 0,
  );
  const sequence = Math.max(
    0,
    numberOrNull(statements.eventHighWater.get()?.value) ?? 0,
  );
  const currentSeq = Math.max(retainedMax, sequence);
  const retainedMin = numberOrNull(statements.minRetainedSeq.get().value);
  const minRetainedSeq =
    retainedMin === null ? currentSeq + 1 : Math.max(0, retainedMin);
  return { currentSeq, minRetainedSeq };
}

function emptyAgentCounts() {
  return { total: 0, running: 0, done: 0, error: 0, unknown: 0 };
}

function countsForRuns(statements, runIds) {
  const output = new Map(runIds.map((runId) => [runId, emptyAgentCounts()]));
  if (runIds.length === 0) return output;
  for (const row of statements.agentCountsForRuns.all(JSON.stringify(runIds))) {
    const counts = output.get(row.run_id);
    if (!counts) continue;
    const value = Number(row.value);
    counts.total += value;
    if (row.status === "running") counts.running += value;
    else if (row.status === "done") counts.done += value;
    else if (row.status === "error") counts.error += value;
    else counts.unknown += value;
  }
  return output;
}

function statusCounters(state) {
  const counters = {};
  for (const key of STATUS_COUNTER_KEYS) {
    counters[key] = Number.isSafeInteger(state?.[key]) ? state[key] : 0;
  }
  return counters;
}

export function createSizeSnapshot(paths, now = () => Date.now()) {
  let cachedAt = -Infinity;
  /** @type {Readonly<{database: number | null, wal: number | null, shm: number | null}>} */
  let cached = Object.freeze({ database: null, wal: null, shm: null });
  const size = (file) => {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null;
    } catch {
      return null;
    }
  };
  return () => {
    const current = now();
    if (current - cachedAt < 1_000) return cached;
    cached = Object.freeze({
      database: size(paths.database),
      wal: size(paths.wal),
      shm: size(paths.shm),
    });
    cachedAt = current;
    return cached;
  };
}

function methodAllowed(request) {
  if (request.method === "GET") return;
  const error = new HttpError(405, "method-not-allowed");
  error.allow = "GET";
  throw error;
}

function parseRunListQuery(url) {
  const parsed = parseStrictQuery(url.searchParams, {
    projectId: (value) => parseOpaqueId(value, "invalid-project-id"),
    status: (value) => {
      if (!RUN_STATUSES.has(value)) badRequest("invalid-status");
      return value;
    },
    kind: (value) => {
      if (!RUN_KINDS.has(value)) badRequest("invalid-kind");
      return value;
    },
    beforeSeq: (value) =>
      parseInteger(value, {
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        code: "invalid-before-seq",
      }),
    beforeRunId: (value) => parseOpaqueId(value, "invalid-before-run-id"),
    limit: (value) =>
      parseInteger(value, {
        minimum: 1,
        maximum: READ_LIMITS.runsMaximum,
        code: "invalid-limit",
      }),
  });
  if ((parsed.beforeSeq === undefined) !== (parsed.beforeRunId === undefined)) {
    badRequest("incomplete-cursor");
  }
  return {
    projectId: parsed.projectId ?? null,
    status: parsed.status ?? null,
    kind: parsed.kind ?? null,
    beforeSeq: parsed.beforeSeq ?? null,
    beforeRunId: parsed.beforeRunId ?? null,
    limit: parsed.limit ?? READ_LIMITS.runsDefault,
  };
}

function parseEventQuery(url) {
  const parsed = parseStrictQuery(url.searchParams, {
    afterSeq: (value) =>
      parseInteger(value, {
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        code: "invalid-after-seq",
      }),
    limit: (value) =>
      parseInteger(value, {
        minimum: 1,
        maximum: READ_LIMITS.eventsMaximum,
        code: "invalid-limit",
      }),
  });
  return {
    suppliedAfterSeq: parsed.afterSeq !== undefined,
    afterSeq: parsed.afterSeq,
    limit: parsed.limit ?? READ_LIMITS.eventsDefault,
  };
}

function readRuns(options, url) {
  const query = parseRunListQuery(url);
  const marks = watermarks(options.statements);
  const rawRows = options.statements.runsPage.all(
    query.projectId,
    query.projectId,
    query.status,
    query.status,
    query.kind,
    query.kind,
    query.beforeSeq,
    query.beforeSeq,
    query.beforeSeq,
    query.beforeRunId,
    query.limit + 1,
  );
  const limitedRows = rawRows.slice(0, query.limit);
  const summaries = takeWithinBudget(limitedRows.map((row) => runSummary(row)));
  const returnedRows = limitedRows.slice(0, summaries.length);
  const counts = countsForRuns(
    options.statements,
    returnedRows.map((row) => row.run_id),
  );
  const runs = returnedRows.map((row, index) => ({
    ...summaries[index],
    agentCounts: counts.get(row.run_id) ?? emptyAgentCounts(),
  }));
  const hasMore = rawRows.length > returnedRows.length;
  const last = returnedRows.at(-1);
  const lastSeq = last ? numberOrNull(last.last_seq) : null;
  return {
    ...marks,
    runs,
    nextCursor:
      hasMore && last && lastSeq !== null
        ? { beforeSeq: lastSeq, beforeRunId: last.run_id }
        : null,
  };
}

function readRun(options, runId) {
  const marks = watermarks(options.statements);
  const row = options.statements.runById.get(runId);
  if (!row) {
    const error = new HttpError(404, "run-not-found");
    error.body = { error: error.code, ...marks };
    throw error;
  }
  const rawAgents = options.statements.agentsForRun.all(
    runId,
    READ_LIMITS.agentsPerRun + 1,
  );
  const limited = rawAgents.slice(0, READ_LIMITS.agentsPerRun);
  const agents = takeWithinBudget(limited.map(agentSummary));
  return {
    ...marks,
    run: runSummary(row),
    agents,
    agentsTruncated: rawAgents.length > agents.length,
  };
}

function readAgent(options, agentId) {
  const marks = watermarks(options.statements);
  const row = options.statements.agentById.get(agentId);
  if (!row) {
    const error = new HttpError(404, "agent-not-found");
    error.body = { error: error.code, ...marks };
    throw error;
  }
  const run = options.statements.agentRun.get(row.run_id);
  if (!run) {
    const error = new HttpError(404, "run-not-found");
    error.body = { error: error.code, ...marks };
    throw error;
  }
  return {
    ...marks,
    agent: agentSummary(row),
    run: {
      runId: run.run_id,
      runKind: run.run_kind,
      status: run.status,
      name: run.name,
      projectId: run.project_id,
      projectRoot: run.project_root,
    },
  };
}

function readEvents(options, scope, id, url) {
  const query = parseEventQuery(url);
  const marks = watermarks(options.statements);
  if (
    query.suppliedAfterSeq &&
    marks.minRetainedSeq > 1 &&
    query.afterSeq < marks.minRetainedSeq - 1
  ) {
    const error = new HttpError(410, "cursor-pruned");
    error.body = { error: error.code, ...marks };
    throw error;
  }
  const afterSeq = query.suppliedAfterSeq
    ? query.afterSeq
    : Math.max(0, marks.minRetainedSeq - 1);
  const statement =
    scope === "run"
      ? options.statements.runEvents
      : options.statements.agentEvents;
  const rows = statement.all(id, afterSeq, query.limit + 1);
  const limited = rows.slice(0, query.limit);
  const records = [];
  let bytes = 0;
  for (const row of limited) {
    const record = eventRecord(row);
    const next = encodedBytes(record);
    if (bytes + next > READ_LIMITS.eventPageBytes) break;
    records.push(record);
    bytes += next;
  }
  const hasMore = rows.length > records.length;
  const lastSeq = records.length > 0 ? numberOrNull(records.at(-1).seq) : null;
  const currentSeq = Math.max(marks.currentSeq, lastSeq ?? 0);
  const nextAfterSeq =
    lastSeq !== null
      ? Math.max(afterSeq, lastSeq)
      : Math.max(afterSeq, currentSeq);
  return { ...marks, currentSeq, events: records, nextAfterSeq, hasMore };
}

function readStatus(options) {
  const marks = watermarks(options.statements);
  const config = options.config.current();
  return {
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: BUILD_VERSION,
    schemaVersion: SCHEMA_VERSION,
    ready: options.health.ready,
    degraded: options.health.degraded,
    uptimeMs: Math.max(0, Date.now() - options.startedAt),
    ...marks,
    eventCount: Number(options.statements.eventCount.get().value),
    runCount: Number(options.statements.runCount.get().value),
    agentCount: Number(options.statements.agentCount.get().value),
    sizes: options.sizeSnapshot(),
    policy: {
      capture: config.capture,
      defaultContentMode: config.defaults.contentMode,
      retentionDays: config.defaults.retentionDays,
      maxDatabaseBytes: config.defaults.maxDatabaseBytes,
      maxSpoolBytes: config.defaults.maxSpoolBytes,
      projects: config.projects.map((project) => ({
        root: project.root,
        enabled: project.enabled ?? config.defaults.enabled,
        contentMode: project.contentMode ?? config.defaults.contentMode,
      })),
    },
    counters: statusCounters(options.metrics.state),
    rejectedByReason: { ...options.metrics.state.rejectedByReason },
    redactionByClass: { ...options.metrics.state.redactionByClass },
  };
}

/** Dispatch only the six D3 read routes. Authentication happens before this call. */
export function createReadRouter(options) {
  return function routeRead(request) {
    const url = queryUrl(request);
    const pathname = url.pathname;
    if (pathname === "/v1/status") {
      methodAllowed(request);
      if ([...url.searchParams].length > 0) badRequest();
      return readStatus(options);
    }
    if (pathname === "/v1/runs") {
      methodAllowed(request);
      return readRuns(options, url);
    }

    let match = /^\/v1\/runs\/([^/]+)(\/events)?$/.exec(pathname);
    if (match) {
      methodAllowed(request);
      const runId = decodePathId(match[1], "invalid-run-id");
      if (match[2]) return readEvents(options, "run", runId, url);
      if ([...url.searchParams].length > 0) badRequest();
      return readRun(options, runId);
    }

    match = /^\/v1\/agents\/([^/]+)(\/events)?$/.exec(pathname);
    if (match) {
      methodAllowed(request);
      const agentId = decodePathId(match[1], "invalid-agent-id");
      if (match[2]) return readEvents(options, "agent", agentId, url);
      if ([...url.searchParams].length > 0) badRequest();
      return readAgent(options, agentId);
    }
    throw new HttpError(404, "not-found");
  };
}
