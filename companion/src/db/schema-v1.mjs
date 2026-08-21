export const SCHEMA_V1_SQL = `
CREATE TABLE events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  envelope_version    INTEGER NOT NULL CHECK (envelope_version = 1),
  event_kind          TEXT NOT NULL,
  schema_version      INTEGER NOT NULL CHECK (schema_version >= 1),
  producer_id         TEXT NOT NULL,
  producer_seq        INTEGER NOT NULL CHECK (producer_seq >= 0),
  producer_kind       TEXT NOT NULL,
  occurred_at_ms      INTEGER,
  received_at_ms      INTEGER NOT NULL,
  trace_id            TEXT,
  run_id              TEXT,
  parent_run_id       TEXT,
  agent_id             TEXT,
  turn_id              TEXT,
  tool_call_id         TEXT,
  project_id           TEXT,
  payload_json         TEXT NOT NULL CHECK (json_valid(payload_json)),
  redaction_json       TEXT NOT NULL CHECK (json_valid(redaction_json)),
  payload_sha256       TEXT NOT NULL,
  UNIQUE (producer_id, producer_seq)
) STRICT;

CREATE INDEX events_run_seq
  ON events (run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX events_agent_seq
  ON events (agent_id, seq) WHERE agent_id IS NOT NULL;
CREATE INDEX events_tool_call_seq
  ON events (tool_call_id, seq) WHERE tool_call_id IS NOT NULL;
CREATE INDEX events_kind_seq ON events (event_kind, seq);
CREATE INDEX events_project_seq
  ON events (project_id, seq) WHERE project_id IS NOT NULL;

CREATE TABLE runs (
  run_id               TEXT PRIMARY KEY,
  trace_id              TEXT,
  parent_run_id         TEXT,
  run_kind              TEXT NOT NULL,
  project_id            TEXT,
  project_root          TEXT,
  session_id            TEXT,
  name                  TEXT,
  current_phase         TEXT,
  status                TEXT NOT NULL,
  started_at_ms         INTEGER,
  settled_at_ms         INTEGER,
  error_text            TEXT,
  recovered_from_artifact INTEGER NOT NULL DEFAULT 0 CHECK (recovered_from_artifact IN (0, 1)),
  content_mode          TEXT NOT NULL DEFAULT 'rich' CHECK (content_mode IN ('rich', 'metadata', 'disabled')),
  last_seq              INTEGER NOT NULL,
  metadata_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX runs_project_started
  ON runs (project_id, started_at_ms DESC);
CREATE INDEX runs_status_started
  ON runs (status, started_at_ms DESC);

CREATE TABLE agents (
  agent_id              TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  local_id              TEXT,
  workflow_index        INTEGER,
  origin                TEXT NOT NULL,
  backend               TEXT NOT NULL,
  role                   TEXT,
  title                  TEXT,
  cwd                    TEXT,
  model                  TEXT,
  native_session_id      TEXT,
  status                 TEXT NOT NULL,
  current_turn_id        TEXT,
  started_at_ms          INTEGER,
  settled_at_ms          INTEGER,
  error_text             TEXT,
  final_preview          TEXT,
  last_seq               INTEGER NOT NULL,
  metadata_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX agents_run_started ON agents (run_id, started_at_ms);
CREATE INDEX agents_status_started ON agents (status, started_at_ms DESC);
CREATE INDEX agents_role ON agents (role) WHERE role IS NOT NULL;
`;

export const APPLICATION_TABLES = Object.freeze(["agents", "events", "runs"]);
export const INTERNAL_TABLES = Object.freeze(["sqlite_sequence"]);
export const EXPLICIT_INDEXES = Object.freeze([
  "agents_role",
  "agents_run_started",
  "agents_status_started",
  "events_agent_seq",
  "events_kind_seq",
  "events_project_seq",
  "events_run_seq",
  "events_tool_call_seq",
  "runs_project_started",
  "runs_status_started",
]);

export const TABLE_COLUMNS = Object.freeze({
  events: [
    "seq",
    "event_id",
    "envelope_version",
    "event_kind",
    "schema_version",
    "producer_id",
    "producer_seq",
    "producer_kind",
    "occurred_at_ms",
    "received_at_ms",
    "trace_id",
    "run_id",
    "parent_run_id",
    "agent_id",
    "turn_id",
    "tool_call_id",
    "project_id",
    "payload_json",
    "redaction_json",
    "payload_sha256",
  ],
  runs: [
    "run_id",
    "trace_id",
    "parent_run_id",
    "run_kind",
    "project_id",
    "project_root",
    "session_id",
    "name",
    "current_phase",
    "status",
    "started_at_ms",
    "settled_at_ms",
    "error_text",
    "recovered_from_artifact",
    "content_mode",
    "last_seq",
    "metadata_json",
  ],
  agents: [
    "agent_id",
    "run_id",
    "local_id",
    "workflow_index",
    "origin",
    "backend",
    "role",
    "title",
    "cwd",
    "model",
    "native_session_id",
    "status",
    "current_turn_id",
    "started_at_ms",
    "settled_at_ms",
    "error_text",
    "final_preview",
    "last_seq",
    "metadata_json",
  ],
});

export const INDEX_COLUMNS = Object.freeze({
  agents_role: ["role"],
  agents_run_started: ["run_id", "started_at_ms"],
  agents_status_started: ["status", "started_at_ms"],
  events_agent_seq: ["agent_id", "seq"],
  events_kind_seq: ["event_kind", "seq"],
  events_project_seq: ["project_id", "seq"],
  events_run_seq: ["run_id", "seq"],
  events_tool_call_seq: ["tool_call_id", "seq"],
  runs_project_started: ["project_id", "started_at_ms"],
  runs_status_started: ["status", "started_at_ms"],
});
