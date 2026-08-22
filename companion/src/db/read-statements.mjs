export function createReadStatements(db) {
  const prepare = (sql) => {
    const statement = db.prepare(sql);
    // Same-UID tampering can place any signed 64-bit INTEGER in a STRICT table.
    // Read BigInts so node:sqlite never rejects a whole route before the
    // projection mapper can degrade values outside JavaScript's safe range.
    statement.setReadBigInts(true);
    return statement;
  };
  return Object.freeze({
    maxRetainedSeq: prepare(
      "SELECT COALESCE(MAX(seq), 0) AS value FROM events",
    ),
    minRetainedSeq: prepare("SELECT MIN(seq) AS value FROM events"),
    eventHighWater: prepare(
      "SELECT seq AS value FROM sqlite_sequence WHERE name = 'events'",
    ),
    eventCount: prepare("SELECT COUNT(*) AS value FROM events"),
    runCount: prepare("SELECT COUNT(*) AS value FROM runs"),
    agentCount: prepare("SELECT COUNT(*) AS value FROM agents"),
    runsPage: prepare(`
      SELECT *
      FROM runs
      WHERE (? IS NULL OR project_id = ?)
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR run_kind = ?)
        AND (
          ? IS NULL
          OR last_seq < ?
          OR (last_seq = ? AND run_id < ?)
        )
      ORDER BY last_seq DESC, run_id DESC
      LIMIT ?
    `),
    agentCountsForRuns: prepare(`
      SELECT run_id, status, COUNT(*) AS value
      FROM agents
      WHERE run_id IN (SELECT value FROM json_each(?))
      GROUP BY run_id, status
      ORDER BY run_id ASC, status ASC
    `),
    runById: prepare("SELECT * FROM runs WHERE run_id = ?"),
    agentsForRun: prepare(`
      SELECT *
      FROM agents
      WHERE run_id = ?
      ORDER BY
        workflow_index IS NULL ASC,
        workflow_index ASC,
        started_at_ms IS NULL ASC,
        started_at_ms ASC,
        agent_id ASC
      LIMIT ?
    `),
    agentById: prepare("SELECT * FROM agents WHERE agent_id = ?"),
    agentRun: prepare(`
      SELECT run_id, run_kind, status, name, project_id, project_root
      FROM runs
      WHERE run_id = ?
    `),
    runEvents: prepare(`
      SELECT *
      FROM events
      WHERE run_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `),
    agentEvents: prepare(`
      SELECT *
      FROM events
      WHERE agent_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `),
  });
}
