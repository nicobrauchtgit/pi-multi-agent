import { canonicalJson } from "../ingest/normalize.mjs";
import { reduceProjection } from "./reducer.mjs";

function runValues(row) {
  return [
    row.run_id,
    row.trace_id,
    row.parent_run_id,
    row.run_kind,
    row.project_id,
    row.project_root,
    row.session_id,
    row.name,
    row.current_phase,
    row.status,
    row.started_at_ms,
    row.settled_at_ms,
    row.error_text,
    row.recovered_from_artifact,
    row.content_mode,
    row.last_seq,
    canonicalJson(row.metadata_json),
  ];
}

function agentValues(row) {
  return [
    row.agent_id,
    row.run_id,
    row.local_id,
    row.workflow_index,
    row.origin,
    row.backend,
    row.role,
    row.title,
    row.cwd,
    row.model,
    row.native_session_id,
    row.status,
    row.current_turn_id,
    row.started_at_ms,
    row.settled_at_ms,
    row.error_text,
    row.final_preview,
    row.last_seq,
    canonicalJson(row.metadata_json),
  ];
}

export function applyProjection(statements, event) {
  const currentRun = event.runId
    ? (statements.runById.get(event.runId) ?? null)
    : null;
  const currentAgent = event.agentId
    ? (statements.agentById.get(event.agentId) ?? null)
    : null;
  const patch = reduceProjection(
    { run: currentRun, agent: currentAgent },
    event,
  );
  if (patch.run) statements.upsertRun.run(...runValues(patch.run));
  if (patch.agent) statements.upsertAgent.run(...agentValues(patch.agent));
  return patch;
}

export function storedEventFromRow(row) {
  const stored = JSON.parse(row.payload_json);
  return {
    seq: Number(row.seq),
    eventId: row.event_id,
    eventKind: row.event_kind,
    schemaVersion: Number(row.schema_version),
    producerId: row.producer_id,
    producerSeq: Number(row.producer_seq),
    producerKind: row.producer_kind,
    occurredAtMs:
      row.occurred_at_ms === null ? null : Number(row.occurred_at_ms),
    receivedAtMs: Number(row.received_at_ms),
    traceId: row.trace_id,
    runId: row.run_id,
    parentRunId: row.parent_run_id,
    agentId: row.agent_id,
    turnId: row.turn_id,
    toolCallId: row.tool_call_id,
    projectId: row.project_id,
    projectRoot: stored.project?.root ?? null,
    payload: stored.payload ?? {},
    capture: stored.capture ?? { contentMode: "metadata", truncated: false },
  };
}
