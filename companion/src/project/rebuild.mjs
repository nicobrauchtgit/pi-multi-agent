import { createStatements } from "../db/statements.mjs";
import { canonicalJson } from "../ingest/normalize.mjs";
import { applyProjection, storedEventFromRow } from "./apply.mjs";

function snapshot(db) {
  return {
    runs: db.prepare("SELECT * FROM runs ORDER BY run_id").all(),
    agents: db.prepare("SELECT * FROM agents ORDER BY agent_id").all(),
  };
}

function replay(db, statements, pageSize = 256) {
  let cursor = 0;
  let replayed = 0;
  while (true) {
    const rows = statements.pageEvents.all(cursor, pageSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const event = storedEventFromRow(row);
      applyProjection(statements, event);
      cursor = event.seq;
      replayed++;
    }
  }
  return replayed;
}

export function rebuildProjections(db, options = {}) {
  const before = snapshot(db);
  const statements = createStatements(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM agents; DELETE FROM runs;");
    const replayed = replay(db, statements, options.pageSize);
    const after = snapshot(db);
    const equal = canonicalJson(before) === canonicalJson(after);
    if (options.check) db.exec("ROLLBACK");
    else db.exec("COMMIT");
    return {
      replayed,
      equal,
      changed: !equal,
      runCount: after.runs.length,
      agentCount: after.agents.length,
      wrote: !options.check,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the reducer/storage error.
    }
    throw error;
  }
}
