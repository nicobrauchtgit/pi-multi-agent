export function createStatements(db) {
  return Object.freeze({
    eventById: db.prepare(
      "SELECT seq, event_id, producer_id, producer_seq, payload_sha256 FROM events WHERE event_id = ?",
    ),
    eventByProducer: db.prepare(
      "SELECT seq, event_id, producer_id, producer_seq, payload_sha256 FROM events WHERE producer_id = ? AND producer_seq = ?",
    ),
    maxProducerSeq: db.prepare(
      "SELECT COALESCE(MAX(producer_seq), 0) AS value FROM events WHERE producer_id = ?",
    ),
    producerGapCount: db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN max_seq > positive_count THEN max_seq - positive_count ELSE 0 END
      ), 0) AS value
      FROM (
        SELECT
          MAX(producer_seq) AS max_seq,
          SUM(CASE WHEN producer_seq >= 1 THEN 1 ELSE 0 END) AS positive_count
        FROM events
        GROUP BY producer_id
      )
    `),
    insertEvent: db.prepare(`
      INSERT INTO events (
        event_id, envelope_version, event_kind, schema_version,
        producer_id, producer_seq, producer_kind, occurred_at_ms,
        received_at_ms, trace_id, run_id, parent_run_id, agent_id,
        turn_id, tool_call_id, project_id, payload_json,
        redaction_json, payload_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    runById: db.prepare("SELECT * FROM runs WHERE run_id = ?"),
    agentById: db.prepare("SELECT * FROM agents WHERE agent_id = ?"),
    upsertRun: db.prepare(`
      INSERT INTO runs (
        run_id, trace_id, parent_run_id, run_kind, project_id, project_root,
        session_id, name, current_phase, status, started_at_ms, settled_at_ms,
        error_text, recovered_from_artifact, content_mode, last_seq, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        trace_id=excluded.trace_id,
        parent_run_id=excluded.parent_run_id,
        run_kind=excluded.run_kind,
        project_id=excluded.project_id,
        project_root=excluded.project_root,
        session_id=excluded.session_id,
        name=excluded.name,
        current_phase=excluded.current_phase,
        status=excluded.status,
        started_at_ms=excluded.started_at_ms,
        settled_at_ms=excluded.settled_at_ms,
        error_text=excluded.error_text,
        recovered_from_artifact=excluded.recovered_from_artifact,
        content_mode=excluded.content_mode,
        last_seq=excluded.last_seq,
        metadata_json=excluded.metadata_json
      WHERE excluded.last_seq > runs.last_seq
    `),
    upsertAgent: db.prepare(`
      INSERT INTO agents (
        agent_id, run_id, local_id, workflow_index, origin, backend, role,
        title, cwd, model, native_session_id, status, current_turn_id,
        started_at_ms, settled_at_ms, error_text, final_preview,
        last_seq, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        run_id=excluded.run_id,
        local_id=excluded.local_id,
        workflow_index=excluded.workflow_index,
        origin=excluded.origin,
        backend=excluded.backend,
        role=excluded.role,
        title=excluded.title,
        cwd=excluded.cwd,
        model=excluded.model,
        native_session_id=excluded.native_session_id,
        status=excluded.status,
        current_turn_id=excluded.current_turn_id,
        started_at_ms=excluded.started_at_ms,
        settled_at_ms=excluded.settled_at_ms,
        error_text=excluded.error_text,
        final_preview=excluded.final_preview,
        last_seq=excluded.last_seq,
        metadata_json=excluded.metadata_json
      WHERE excluded.last_seq > agents.last_seq
    `),
    maxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS value FROM events"),
    pageEvents: db.prepare(
      "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
    ),
  });
}
