# Observability architecture

_Status: accepted implementation plan; intentionally staged_  
_Last updated: 2026-08-21_

This document is the canonical plan for local observability in Pi Multi-Agent. It is specific enough to implement, but it deliberately avoids building the final analytics platform before the first useful slice has been dogfooded.

## 1. Goals

The first useful release must:

- show a durable timeline for parent Pi sessions, workflows, and standalone or workflow-owned agents;
- use Pi hooks and the unified `SubagentManager` event boundary as the primary source of truth;
- survive daemon downtime and producer restarts without blocking orchestration;
- recover or enrich missing facts idempotently from repository-owned artifacts;
- keep rich local prompts, messages, tool data, results, and structured output within explicit byte bounds;
- redact common secrets before any observability-owned disk write and re-redact every payload in the daemon;
- provide a read-only local web UI with a small HTTP API and cursor polling;
- support per-project disable/content-exclusion policy, bounded retention, purge, and export;
- leave the event contract adaptable to future independent Claude Code, Codex, CI, and remote adapters.

Observability is a read-side mirror. It must never become an orchestration dependency, a model-visible workflow budget, a direct agent-to-agent bus, or a replacement for explicit workflow return values.

## 2. Non-goals for the first vertical slice

The following are explicitly deferred:

- a large normalized analytics schema;
- content-addressed external blob files, S3, or PostgreSQL;
- Redis, a broker, or a separate frontend server;
- Unix-domain sockets or non-loopback listeners;
- remote-producer authentication or multi-user access;
- native Claude Code or Codex session-file harvesting;
- exact per-agent diff attribution in a shared worktree;
- worktree or branch isolation;
- a complete Server-Sent Events protocol;
- web mutation/control endpoints;
- a model-visible observability tool.

Polling is sufficient until measured UI use shows otherwise. Bounded content remains inline in SQLite until database-size evidence justifies another tier.

## 3. Accepted decisions and invariants

1. **One companion process.** One local daemon owns SQLite, ingestion, projection updates, the read API, and static UI files.
2. **One SQLite writer.** The daemon is the only live writer and uses WAL mode. Offline purge may write only after acquiring the same daemon lock while the daemon is stopped.
3. **Hooks and manager events are primary.** Artifacts are recovery and enrichment inputs and never override a known authoritative manager or Pi-hook fact.
4. **One workflow-agent vocabulary.** C1 fully removes the legacy workflow child-runner path before any database phase begins.
5. **Clear C0/C1 ownership.** C0 workflow events describe only run-level phase/log/settle. After C1, all workflow-owned agent lifecycle, messages, tools, usage, and settlement come only from `SubagentManager`.
6. **Durable identity precedes child work.** Manager-owned `runId`, `agentId`, origin, and workflow linkage are minted before `backend.spawn()`. V1 observes child activity at the manager boundary. Exact attribution of child-extension hooks is deferred until Pi exposes a per-session, non-racy context that is available before the child's `session_start`.
7. **No unredacted observability shadow.** The producer redacts before spooling or writing new observability artifacts. The daemon independently re-redacts all accepted payloads, including unknown event kinds. Existing native/session artifacts may predate this system; reconciliation never copies them without redaction.
8. **Every stored byte was scanned.** Oversized requests or non-content envelopes are rejected before persistence. Oversized content fields are fully scanned, bounded/truncated, and fully scanned again; field-cap overflow alone does not discard the event.
9. **Receive order is authoritative.** Projection reducers use daemon-assigned `events.seq`, not producer wall-clock last-write-wins. Producer timestamps are display data only.
10. **Child agents cannot read observability state through supported tools.** Companion tokens, database files, WAL/SHM files, spool, configuration, and new run artifacts are protected paths in every child backend. Permission and deny-path verification are release gates.
11. **Read-only web surface first.** The internal ingest route writes, but browser-facing v1 routes do not mutate orchestration or stored data. Purge is an offline local maintenance operation.
12. **Errors remain the signal.** Observability may display or derive labels, but it adds no new blocked/input-required lifecycle state.

## 4. Current integration facts

The plan relies on current repository behavior rather than a hypothetical rewrite:

- `extensions/subagents/src/domain.ts` defines the normalized event union used by Pi, Claude, and Codex backends.
- `SubagentManager` is already the single consumer that folds those events into live snapshots.
- Current `sa-N` and `btw-N` identifiers are process-local and are allocated after `backend.spawn()`; C0 must add separate durable IDs allocated before spawn while retaining those short IDs for display.
- Task C groundwork already carries workflow origin/ownership metadata through manager snapshots, suppresses standalone auto-delivery for workflow-origin agents, and exposes manager wait/get delivery seams. These are preparatory seams only: C0 durable identity/events and C1 execution unification have not started.
- Workflow `agent()` currently bypasses the manager and uses `extensions/workflows/runner.ts`; C1 retires that execution path.
- Workflow state is currently mutated directly in `extensions/workflows/index.ts` and persisted as bounded `workflow.json`, `result.json`, and `transcripts.json` files.
- Current workflow artifacts are bounded and atomically written, but they do not redact content.
- Pi child sessions load extensions and bind them during session creation. There is no proven, backend-neutral API for attaching an observability identity before child-extension `session_start`.
- `CHILD_EXCLUDED_TOOL_NAMES` blocks orchestration tools only. File and shell tools can currently reach same-user files, so permissions alone do not protect future observability state from a child agent.
- Concurrent children normally share the same cwd. Hunk and GitButler inspect that shared working copy; neither provides automatic per-agent authorship.

## 5. Context and component diagram

```text
                              primary events
 Parent Pi hooks ───────────────────────────────────────────┐
                                                           │
 Workflow run reducer (phase/log/settle only) ──────────────┤
                                                           v
 Workflow agent() ── C1 ──> SubagentManager ─────────> Producer sink
                                │                          │
                         Pi / Claude / Codex               │ redacts + bounds
                                children                   │ batches / spools
                                                           v
                                              127.0.0.1 ingest endpoint
                                                           │
                                                one companion daemon
                                      ┌────────────────────┼──────────────────┐
                                      │                    │                  │
                               SQLite WAL writer     read-only HTTP API   static UI
                                      ^                    │                  │
                                      │                    └──── polling ─────┘
                        idempotent artifact reconciliation
                     (workflow/shared artifacts and role metadata)
```

There is no broker and no frontend build/runtime server. The daemon uses Node built-ins (`node:http`, `node:fs`, `node:crypto`, and `node:sqlite`) unless implementation evidence proves one small dependency is necessary. The daemon runtime floor is Node 22.5.0, the first Node 22 release with `node:sqlite`; startup must also probe that the built-in is importable. On an older/incompatible runtime, orchestration continues and producers remain in bounded spool-only mode, while the daemon, read API, and UI report unavailable rather than falling back to another SQLite package.

## 6. Identity model

Externally supplied or backend-native IDs are bounded opaque data and are never interpreted as paths. Repository-minted IDs have fixed prefixes and UUID/hex grammars; only those locally minted values may be revalidated against their exact grammar and used as a single path fragment for spool or artifact directories. A path join still must verify containment, and no decoded, external, or merely “sanitized” ID becomes a path fragment.

| ID           | V1 form and owner                                                                                                  | Meaning                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `producerId` | `producer_<UUIDv4>`, minted once per parent Pi process                                                             | Identifies a producer process and scopes `producerSeq`.                                             |
| `traceId`    | `pi-session:<Pi session id>`                                                                                       | Correlates one root Pi session, including resume. Fork/new session IDs naturally create new traces. |
| `runId`      | Existing `wf_<hex>` for workflows; `sa_<UUIDv4>` for standalone manager runs; `pi-run:<session id>` for the parent | Durable orchestration scope.                                                                        |
| `agentId`    | `agent_<UUIDv4>`, minted by `SubagentManager` before backend spawn                                                 | Durable agent/session identity across local display-ID reuse.                                       |
| `turnId`     | `turn_<UUIDv4>`, minted for each initial run or follow-up                                                          | Separates multiple turns in one native agent session.                                               |
| `toolCallId` | `<agentId>:<native id>` or `<runId>:<native id>`                                                                   | Namespaces backend/Pi tool IDs that are not globally unique.                                        |
| `eventId`    | `event_<UUIDv4>`, minted before queueing                                                                           | Idempotency key reused unchanged across spool replay.                                               |

`sa-N`, `btw-N`, workflow agent index, role, and backend-native session IDs remain metadata for display/resume. They are not database keys.

### 6.1 Parent/child hierarchy

- A parent Pi session has one `traceId` and root `runId`.
- A standalone subagent gets its own `runId`, `agentId`, and `parentRunId` pointing to the root run.
- A workflow keeps its existing workflow `runId` and has the root run as `parentRunId`.
- Every workflow `agent()` call uses the workflow `runId`, gets a manager-minted `agentId`, and records `origin: "workflow"` plus `workflowRunId`.
- Follow-ups reuse `agentId` and mint a new `turnId`.

C0 changes manager reservation so durable IDs and origin exist before `backend.spawn(task)`. The IDs travel in immutable spawn metadata and are also present when manager events are observed. V1 does **not** claim child-extension hook events by writing a map after session construction or by mutating a process-wide environment variable; either approach can race under parallel children.

## 7. Event contract

### 7.1 Envelope v1

```json
{
  "v": 1,
  "eventId": "event_…",
  "kind": "agent.tool_finished",
  "schemaVersion": 1,
  "producer": {
    "id": "producer_…",
    "seq": 481,
    "kind": "pi"
  },
  "occurredAt": 1787322056347,
  "ids": {
    "traceId": "pi-session:…",
    "runId": "wf_…",
    "parentRunId": "pi-run:…",
    "agentId": "agent_…",
    "turnId": "turn_…",
    "toolCallId": "agent_…:call_…"
  },
  "project": {
    "id": "sha256:<canonical-root>",
    "root": "/canonical/project/root"
  },
  "payload": {},
  "capture": {
    "contentMode": "rich",
    "truncated": false
  }
}
```

Rules:

- `v` is the envelope major. V1 rejects unsupported majors with `409` and persists none of the request.
- `schemaVersion` versions one event kind. V1 changes are additive within a version.
- Unknown event kinds are accepted only after generic shape/size validation and recursive daemon redaction. They are stored but do not update known projections.
- `producer.seq` is monotonically increasing within one `producerId`. It detects gaps and conflicts; it is not the global query cursor.
- `occurredAt` is optional display/provenance data. It never decides which projection value wins.
- The daemon supplies `received_at_ms` and `events.seq`.
- Every string/key, nesting depth, collection length, event size, and batch size has a hard ingress limit. Request or non-content-envelope violations reject the event; recognized content-field overflow follows the truncation rules in §7.3 instead of rejecting the whole event.

### 7.2 V1 event ownership

| Owner                      | Event kinds                                                                                                                                                     | Notes                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent Pi hooks            | `run.started`, `turn.started`, `message.user`, `message.assistant`, `tool.started`, `tool.finished`, `turn.settled`, `run.settled`, `session.compacted`         | Use `session_start`, `before_agent_start`, finalized message, agent/turn/tool lifecycle, compaction, and shutdown hooks. Hook failures are swallowed after health accounting. |
| Workflow reducer in C0     | `workflow.phase`, `workflow.log`, `workflow.settled`                                                                                                            | Run-level only. Settlement carries the existing start/finish metadata; it never emits workflow-agent lifecycle events.                                                        |
| `SubagentManager` after C1 | `agent.created`, `agent.run_started`, `agent.message`, `agent.tool_started`, `agent.tool_finished`, `agent.usage`, `agent.meta`, `agent.error`, `agent.settled` | Sole owner for standalone and workflow-owned agent lifecycle across all three harnesses.                                                                                      |
| Reconciler                 | `artifact.observed`, `artifact.recovered`                                                                                                                       | Deterministic IDs, source marked `artifact`; fills gaps but does not overwrite primary facts.                                                                                 |
| Producer/daemon            | `telemetry.dropped`, `telemetry.spool_overflow`, `telemetry.rejected`                                                                                           | Contains counts/reasons only, never rejected payload bytes.                                                                                                                   |

Streaming assistant deltas and repeated tool-progress updates are not durable v1 facts. `message.assistant` stores only a finalized parent assistant message; its payload may include separately bounded finalized thinking content when the hook exposes it safely. The sink may coalesce deltas for a live summary, but it persists finalized parent and agent messages, tool results, and lifecycle boundaries. This keeps the event log useful without turning token streaming into most of the database.

### 7.3 Payload policy

V1 keeps content inline. Stored-field caps are measured as the UTF-8 byte length of the final JSON-encoded field value, so JSON escaping is charged to the field rather than hidden as envelope overhead.

| Content                                  |         Stored cap |
| ---------------------------------------- | -----------------: |
| prompt or user message                   |             64 KiB |
| assistant/thinking message               |            128 KiB |
| tool arguments                           |             64 KiB |
| tool result                              |            128 KiB |
| structured result                        |            256 KiB |
| patch/diff when later enabled            |            256 KiB |
| all content fields in one event          |            256 KiB |
| reserved non-content envelope + metadata |            128 KiB |
| one stored event                         |            512 KiB |
| one ingest batch                         | 2 MiB / 128 events |

The 512 KiB event cap is strictly larger than the 256 KiB aggregate content budget plus the 128 KiB envelope allowance. The remaining 128 KiB is safety headroom, not another content budget. IDs, project data, capture/redaction metadata, field names, and JSON container syntax count against the envelope allowance.

Overflow of an individual content field or the aggregate content budget is handled by deterministic UTF-8-safe field truncation/omission, not whole-event rejection. The event records original byte count when known, stored byte count, affected field paths, and `truncated: true`; no original tail is retained. Only a request-level limit or a non-content envelope that cannot fit its allowance/event cap after content is truncated causes rejection without persistence.

Current `SubagentEvent` tool fields are UI previews, not a recoverable rich payload. D2 must not parse or inflate those previews. Backend mappings may attach a separate optional capture value when the native event exposes arguments/results; the producer bounds and redacts it before disk while the existing snapshot preview behavior remains unchanged. If a backend does not expose a value safely, the event records `contentUnavailable` rather than guessing. Finalized message content already available at the manager boundary follows the same bounds. This provides rich capture where evidence exists without relying on racy child-extension hooks.

## 8. Producer sink, batching, and replay

### 8.1 Interface

The parent process owns one process-wide sink:

```ts
interface ObservabilitySink {
  emit(event: PendingObservabilityEvent): void; // synchronous, no throw
  flush(budgetMs: number): Promise<void>;
}
```

`emit` must not await I/O or feed errors into manager/workflow state. It places a bounded record into an internal queue; a worker performs redaction, batching, network I/O, and spool writes. If normalization/redaction fails, the payload is discarded and only a counter/reason is retained.

The sink is called alongside, not inside, existing manager and workflow folds. A sink bug therefore cannot prevent settlement, result delivery, cancellation, or artifact persistence.

### 8.2 Queue and coalescing defaults

- Maximum in-memory queue: 512 events or 4 MiB, whichever is reached first.
- Flush: every 100 ms, at 64 events, or at 512 KiB.
- Coalesce latest usage/meta/tool-progress update per entity while queued.
- Do not coalesce creation, run/turn start, finalized message, tool completion, error, phase/log, or settlement events.
- On pressure, discard coalescable progress first. If a durable event cannot be queued, move it to the spool worker and increment a gap counter.

The exact numbers are configuration constants and must be exercised under load before being made user-facing settings.

### 8.3 Protected spool

Spool records are already redacted and bounded event envelopes. Raw producer payloads never enter a segment.

```text
~/.pi/agent/multi-agent/observability/
  spool/
    <producer-id>/
      00000001.ndjson
      00000002.ndjson
```

Defaults:

- 8 MiB maximum per segment;
- 64 MiB total spool cap across every producer directory;
- directories `0700`, files `0600`;
- each batch is written to a temporary file, closed, and atomically renamed to an immutable `.ndjson` segment; replay never reads a file still being written;
- complete lines from an abandoned temporary file may be promoted after the file is unchanged across the conservative stale-write window; a partial crash tail is discarded and counted;
- malformed redacted segments are quarantined within the same cap and never logged verbatim;
- when the hard cap is exhausted, evict coalescable records/segments first, then the oldest segment, and persist only dropped counts in a small protected state file.

Spool ownership is shared recovery work, not lifetime ownership by the `producerId` that created a directory. On daemon startup and periodically while idle, the daemon scans every producer directory and feeds immutable segments through the same validation, redaction, transaction, and projection path as HTTP ingest. On producer startup/reconnect, the one sink selected by the process-wide shared module guard also scans **all** producer directories, including foreign/dead producer IDs, and replays backlog before sending newer live events. Replay preserves filename order within each producer; ties across producers may use a deterministic directory order because daemon receive sequence remains authoritative.

The daemon acknowledges committed event IDs/highest producer sequence only after the SQLite transaction commits. A segment is deleted only after every complete record in it is durable. Concurrent daemon/producer replay is safe: immutable segments may be submitted twice, `eventId` makes insertion idempotent, and an already-removed segment is treated as successfully reclaimed.

Reclaim/GC is mandatory and counts against the same 64 MiB cap: remove acknowledged segments immediately; recover complete lines and discard only the incomplete tail of stale temporary files; evict quarantined/oldest segments under the cap policy; and remove a producer directory once it contains no replayable, temporary, or quarantined files. Thus a producer exit cannot strand durable backlog or permanently reserve spool capacity.

Delivery is at least once. `eventId` is reused unchanged by every replayer.

## 9. Daemon lifecycle and ownership

### 9.1 Pi-side owner

After C1, `extensions/subagents/index.ts` is the sole Pi-side owner of the manager, sink, and `ensureDaemon()` call. The workflow extension consumes manager/sink services but never starts or stops the daemon independently. If workflows are loaded without the subagents service, the extension may load for diagnostics, but workflow execution fails clearly rather than reviving the legacy runner.

A process-wide shared module guard ensures repeated `session_start` hooks or `/reload` do not create multiple producers. `session_shutdown` performs a bounded sink flush and spools the remainder; it disposes child sessions as it does today but does not kill a daemon that may serve another Pi session or browser.

### 9.2 Companion home

```text
~/.pi/agent/multi-agent/observability/       0700
  daemon.lock                               0600
  daemon.json                               0600
  ingest.token                              0600
  read.token                                0600
  observability.sqlite3                     0600
  observability.sqlite3-wal                 0600
  observability.sqlite3-shm                 0600
  reconcile-state.json                      0600
  spool/                                    0700
  logs/                                     0700
```

`daemon.json` contains protocol version, PID, loopback port, start time, and build version, but not tokens. Tokens are random 32-byte base64url capabilities with separate ingest and read authority.

At every startup the daemon:

1. uses `lstat`, rejects symlinks, verifies the current UID owns every existing component, and tightens/verifies directory mode `0700` and file mode `0600`;
2. acquires an exclusive create lock using the repository's dead-PID recovery pattern;
3. starts/migrates SQLite and verifies the DB, WAL, and SHM modes after SQLite creates them;
4. binds only `127.0.0.1` on an ephemeral port;
5. atomically writes `daemon.json`;
6. reports ready only after migrations and permission checks pass.

A second starter reads the state, checks unauthenticated protocol readiness, then authenticates a read/status request before reusing the process. It never starts a second writer. Stale locks are reclaimed only after PID/start-token validation.

### 9.3 Autostart and idle exit

On parent `session_start`, the owner performs a short readiness check followed by an authenticated status request. If unavailable, it starts `process.execPath companion/daemon.mjs` detached and polls readiness within a small bounded startup budget. Pi startup and agent work continue even if readiness fails; the sink enters spool mode and emits one non-sensitive diagnostic.

No lease table is needed in v1. The daemon tracks last ingest/read activity in memory and exits after a configurable 30-minute idle period when there are no in-flight requests. SIGTERM/SIGINT stops accepts, finishes or rolls back the current batch, closes SQLite cleanly, and removes only its own matching state/lock.

Protocol/build incompatibility produces a clear health state and spool fallback. It never deletes or auto-migrates a newer database.

## 10. Minimal SQLite v1

### 10.1 Pragmas

The daemon opens one write connection and applies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA auto_vacuum = INCREMENTAL;
```

`journal_mode` and `auto_vacuum` are established at database creation. Batches use `BEGIN IMMEDIATE` so insertion and projection updates commit atomically.

### 10.2 Schema

V1 has three application tables. Turn, tool, message, redaction, artifact, and diff detail remain events until dogfooding demonstrates a query that deserves normalization.

```sql
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
  agent_id            TEXT,
  turn_id             TEXT,
  tool_call_id        TEXT,
  project_id          TEXT,
  payload_json        TEXT NOT NULL CHECK (json_valid(payload_json)),
  redaction_json      TEXT NOT NULL CHECK (json_valid(redaction_json)),
  payload_sha256      TEXT NOT NULL,
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
  trace_id             TEXT,
  parent_run_id        TEXT,
  run_kind             TEXT NOT NULL,
  project_id           TEXT,
  project_root         TEXT,
  session_id           TEXT,
  name                 TEXT,
  current_phase        TEXT,
  status               TEXT NOT NULL,
  started_at_ms        INTEGER,
  settled_at_ms        INTEGER,
  error_text           TEXT,
  recovered_from_artifact INTEGER NOT NULL DEFAULT 0 CHECK (recovered_from_artifact IN (0, 1)),
  content_mode         TEXT NOT NULL DEFAULT 'rich' CHECK (content_mode IN ('rich', 'metadata', 'disabled')),
  last_seq             INTEGER NOT NULL,
  metadata_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX runs_project_started
  ON runs (project_id, started_at_ms DESC);
CREATE INDEX runs_status_started
  ON runs (status, started_at_ms DESC);

CREATE TABLE agents (
  agent_id             TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  local_id             TEXT,
  workflow_index       INTEGER,
  origin               TEXT NOT NULL,
  backend              TEXT NOT NULL,
  role                 TEXT,
  title                TEXT,
  cwd                  TEXT,
  model                 TEXT,
  native_session_id    TEXT,
  status                TEXT NOT NULL,
  current_turn_id      TEXT,
  started_at_ms        INTEGER,
  settled_at_ms        INTEGER,
  error_text           TEXT,
  final_preview        TEXT,
  last_seq             INTEGER NOT NULL,
  metadata_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX agents_run_started ON agents (run_id, started_at_ms);
CREATE INDEX agents_status_started ON agents (status, started_at_ms DESC);
CREATE INDEX agents_role ON agents (role) WHERE role IS NOT NULL;
```

The event table intentionally has no foreign key to projections: events may arrive before creation facts during recovery. `toolCallId` is copied from `ids.toolCallId` into nullable `events.tool_call_id`; the envelope remains authoritative, while the partial `(tool_call_id, seq)` index supports timings and correlated start/finish lookup without a v1 tools table. The reducer creates an explicit incomplete run projection when necessary and fills it when an authoritative creation event arrives.

### 10.3 Insert, idempotency, and projections

For each batch, in receive order:

1. validate, path-filter, re-redact, bound, and re-scan the event;
2. compute `payload_sha256` over the exact stored envelope payload;
3. insert the event and obtain daemon `seq`;
4. if `event_id` already exists with the same hash, acknowledge it without projecting again;
5. if the same `event_id` or `(producer_id, producer_seq)` has different stored bytes, reject the conflicting record, retain the original, and increment a conflict counter without logging content;
6. apply the known-kind reducer using the newly assigned `seq`;
7. commit event and projections together.

Every projection update requires `incoming seq > last_seq`. A reducer initializes an incomplete projection in memory with `last_seq = 0`, then applies the triggering event in the same transaction, so the persisted row leaves that transaction with `last_seq = incoming seq`; no persisted placeholder remains at zero. Reducers consume `ORDER BY seq`; `occurred_at_ms` never guards an update. A terminal agent can return to running only for an authoritative `agent.run_started` with a distinct `turnId`. Artifact events fill null/missing fields or recover a run that has no primary terminal fact; they do not replace manager/hook fields merely because the artifact was received later.

The spool protocol replays before live traffic for each producer, preserving producer event order. Projection rebuild truncates only `runs` and `agents`, then replays retained known events by ascending `seq` through the same reducer.

### 10.4 Migrations

SQLite `PRAGMA user_version` is the schema version; no fourth migration table is added.

- A new DB is created as version 1 in one migration transaction.
- Each later migration is ordered, checks its expected prior version, and updates `user_version` only in the same successful transaction.
- Startup refuses a DB newer than the binary.
- Before a destructive future migration, the daemon checkpoints WAL and creates a protected backup or requires explicit operator confirmation; v1 has no destructive migration.
- Migration tests open fixtures at every supported version, run twice for idempotency, then run `quick_check`, schema assertions, and projection rebuild comparison.
- Migration failure leaves the prior DB intact when SQLite permits, marks the daemon unhealthy, and sends producers to spool mode. It never silently creates a replacement DB.

## 11. Redaction and capture security

### 11.1 Two enforcement points

One standalone redaction implementation is imported by both producer and daemon. It is a dependency-free ESM file at `extensions/shared/redaction.mjs`, with JSDoc types plus a checked `.d.ts` facade: Pi's TypeScript extension imports the `.mjs` directly, and bare Node imports the same file without a transpile/build step. Tests execute both entry contexts against the same fixtures; a copied daemon implementation is forbidden.

- **Producer:** redacts before spool and before any new observability-owned artifact write.
- **Daemon:** treats the producer as untrusted and recursively re-redacts every accepted event, including unknown kinds and artifact imports.

No request body, rejected event, secret match, or SQL parameter is written to logs. Redaction telemetry contains only coarse rule class and count, not matched values or exact secret lengths.

### 11.2 Required processing order

For every string-bearing payload:

1. enforce the raw request/batch byte cap and reject a request-level overflow without persistence;
2. parse into inert JSON with depth, node-count, key-count, and non-content string-size limits, rejecting invalid or oversized envelope structure;
3. apply project and secret-path content policy;
4. scan **all** accepted content bytes and replace common-secret matches;
5. JSON-encode and UTF-8-safely bound/truncate individual content fields and then the aggregate content budget from §7.3;
6. scan the complete stored values again;
7. serialize the final event, verify the 128 KiB non-content envelope allowance and 512 KiB stored-event cap, and reject only if the envelope itself still cannot fit;
8. hash only the final stored value.

There is no “scan first MiB, store two MiB” mode and no unscanned tail. Redaction happens before truncation so a truncation boundary cannot expose half of a recognized credential; the second scan verifies the exact persisted bytes. Field-level overflow always produces truncation/omission metadata and preserves the event. Whole-event rejection is reserved for request-level or non-content-envelope violations, never merely because a recognized content field exceeded its stored cap.

### 11.3 Common-secret rules

The initial fixed, reviewed rule set covers at least:

- authorization/bearer and cookie headers;
- password/secret/token/API-key/private-key fields in JSON, env, and common CLI output;
- PEM private-key blocks;
- common GitHub, AWS, npm, Slack, and similar recognizable token forms;
- credentials embedded in URLs/connection strings.

Rules must be linear or otherwise demonstrably bounded. User-supplied regex is not part of v1. Arbitrarily encoded/encrypted secrets cannot be reliably recognized; path suppression and purge are therefore required rather than overstating scanner guarantees.

### 11.4 Secret-path policy

Default excluded content paths include `.env*`, `*.pem`, private keys, `.ssh/**`, cloud credential directories/files, auth files such as `.npmrc`, and the companion home itself. When Moshi interoperability is configured, the same canonical policy also includes its Unix socket and local state/session directories. Per-project configuration may add exclusions.

The policy applies to **reads, tool arguments/results, messages, structured results, patches/diffs, and mutations**:

- producers attach canonical content provenance/path metadata when known;
- if content originates from an excluded path, store operation, path classification, byte counts, and omission reason only—never content or a content hash;
- daemon reconciliation resolves paths beneath configured roots, rejects traversal/symlink escape, and reapplies the same policy;
- messages/results without reliable path provenance still receive generic secret scanning;
- a bash command that accesses a protected observability path is blocked by child policy, not merely redacted afterward.

### 11.5 Child deny-path integration

`extensions/shared/child-session.ts` must expose one canonical protected-path policy used by Pi, Claude, Codex, workflow-owned, standalone, and resumed children. It includes:

- `~/.pi/agent/multi-agent/observability/**`;
- existing `~/.pi/agent/workflows/**` and new redacted run-artifact locations;
- configuration containing observability credentials;
- token, DB, WAL/SHM, spool, lock/state, export, and maintenance files;
- when configured, Moshi's Unix socket and local state/session directories, because same-UID children otherwise share access.

Requirements:

1. canonicalize relative paths, `~`, symlinks, and parent traversal before a file-tool decision;
2. reject read, write, edit, search, and patch operations targeting protected paths;
3. enforce shell access at an actual backend permission/sandbox boundary—command-string matching alone is not an acceptable security boundary;
4. never pass token values or companion paths in a child prompt, environment variable, result, or native resume record;
5. test direct path, symlink, glob/search, and shell access for every enabled backend.

If a backend cannot enforce the protected path for its normal file and shell tools, rich observability must remain disabled for that backend or the unsafe tool must be unavailable. The system must not silently rely on `0600` against a child running as the same OS user.

This boundary protects against model actions through supported child tools. It does not claim to isolate arbitrary malicious native code already running as the user's UID.

### 11.6 HTTP and browser security

- Bind only `127.0.0.1`; no wildcard, IPv6-any, Unix socket, or remote mode in v1.
- Require the ingest token for `POST /v1/ingest` and the distinct read token for every data/API read.
- Expose unauthenticated `/healthz` with protocol/build/readiness only—no paths, counts, projects, or errors containing user data.
- Require an exact `Host: 127.0.0.1:<port>` and reject cross-origin requests; emit no permissive CORS headers.
- Validate content type and request length before reading/parsing a body.
- Use prepared statements and allowlisted sort/filter fields.
- Serve strict CSP, `nosniff`, no-referrer, and no-store headers. Render captured strings with DOM `textContent`, never `innerHTML`.
- A trusted parent command may open `http://127.0.0.1:<port>/#<read-token>`. The fragment is not sent in HTTP logs; the static app keeps it in memory and uses a bearer header. The read token cannot ingest or control. It rotates on daemon restart.
- Browser-facing v1 has no purge, cancel, steer, retry, or configuration routes.

## 12. Read API, polling, and UI MVP

### 12.1 Routes

Internal write route:

- `POST /v1/ingest` — authenticated producer batches only.

Read-only routes:

- `GET /healthz`
- `GET /v1/status` — schema/build, current/max sequence, retention floor, DB/spool sizes, redaction/drop/conflict counts;
- `GET /v1/runs?projectId=&status=&kind=&beforeSeq=&limit=`;
- `GET /v1/runs/:runId` — run projection plus agent summaries;
- `GET /v1/runs/:runId/events?afterSeq=&limit=`;
- `GET /v1/agents/:agentId` — agent projection;
- `GET /v1/agents/:agentId/events?afterSeq=&limit=`;
- `GET /v1/export?projectId=&runId=&afterSeq=&beforeSeq=` — streams already-redacted JSONL.

IDs are parsed as bounded opaque values and passed only to prepared statements. Pagination limits are capped server-side.

### 12.2 Cursor polling

There is no global events-feed route in v1. A run or agent detail view loads its projection, records the returned global `currentSeq` watermark, then polls that entity's scoped `/events?afterSeq=` route every two seconds. The cursor advances to the greatest sequence actually returned for that scope; an empty response may also advance it to the response's `currentSeq`, because any skipped sequences belong to other scopes. The runs list and system-health views poll `/v1/runs` and `/v1/status` respectively and replace their projection snapshot when `currentSeq` advances; they do not attempt event-by-event folding.

Every polling response includes `currentSeq` and `minRetainedSeq`. If retention has removed the requested range, the daemon returns `410` with the new floor and the UI reloads the relevant projection. This is the only v1 live-update contract. SSE may later reuse daemon sequence cursors if polling is measured to be inadequate; no full SSE protocol is committed now.

### 12.3 UI information architecture

The static no-build UI has four views:

1. **Runs:** project/status/kind filters; start time, duration, phase, agent counts, failure, redaction/truncation badges.
2. **Run timeline:** workflow phases/logs, parent turns, agent lanes, tool durations, usage/meta changes, artifact-recovery markers.
3. **Agent detail:** role/backend/model/native locator metadata, turns, bounded messages, tool calls/results, structured result preview, queue/failure history.
4. **System health:** daemon/build/schema, DB/WAL/spool size, oldest retained time/sequence, dropped/conflicting events, redaction counts, disabled/metadata-only projects.

Diffs are absent until their attribution label is honest. Every content panel distinguishes `redacted`, `omitted by path policy`, `truncated`, and `unavailable`.

## 13. Artifact persistence and reconciliation

Artifacts remain useful for crash recovery but are not a second event vocabulary.

### 13.1 V1 sources

D4 handles repository-owned, bounded formats first:

- existing workflow `workflow.json`, `result.json`, and `transcripts.json`;
- new shared redacted run artifacts produced after C1;
- role records for metadata/native-session linkage.

Native Pi/Claude/Codex session-file harvesting is deferred. In particular, v1 does not build separate Claude/Codex tailers. A future optional Moshi projection importer is governed separately by §21 and is not a v1 source.

### 13.2 Import safety and idempotency

The reconciler:

- scans only allowlisted roots and filenames;
- uses `lstat`, rejects symlink traversal, and enforces file/count/total-byte limits;
- parses with bounded serialization rules;
- applies secret-path policy and the full daemon redaction pipeline;
- creates deterministic `eventId = sha256("artifact-v1\0" + sourceKind + "\0" + canonicalPath + "\0" + storedContentHash)`;
- marks provenance and recovery confidence in `payload`;
- never mutates the source artifact.

A small protected `reconcile-state.json` records canonical source identity, last processed fingerprint, and an `imported`, `skipped-policy`, or `purged` decision—never source content. A repeated scan of an unchanged fingerprint inserts nothing even if retention has removed its old event. A changed checkpoint creates a new observation event only if it is still within current project/retention policy. The state file is bounded by source count and drops entries only after the source has been absent beyond retention. This avoids an importer table while preventing old artifacts from being re-imported after retention or purge.

### 13.3 Projection precedence

- Primary Pi-hook/manager fields win.
- Artifacts may fill a null preview, result, native locator, or terminal fact absent because the producer crashed.
- Artifact recovery marks `recovered_from_artifact = 1` and remains visible in the UI.
- A later primary event may replace an artifact-recovered field through an explicit reducer rule, ordered by daemon sequence.
- Artifact `occurredAt` never wins merely because its wall clock is later.

Before D4 calls the new artifact layout complete, new workflow/shared run artifacts must use the same producer scrubber. Existing unredacted workflow artifacts are treated as input sources, not copied shadows.

## 14. Honest diff attribution roadmap

The shared working directory prevents exact authorship today. The UI and API must never imply more confidence than the evidence supports.

### Stage 0 — v1 timeline

Record cwd/project, tool name, known canonical paths, and content-policy metadata. Do not label a patch as agent-authored. Hunk comments and assistant claims are context, not proof.

### Stage 1 — post-dogfood shared change summary

At manager run boundaries, optionally capture bounded pre/post changed-file metadata for the run's project: path, status, size, and non-secret hash. If agents overlap in the same worktree, label the result `shared/unattributed`. Excluded paths have no content hash.

This may be D5 only after the D1-D4 timeline is useful and storage data is available.

### Stage 2 — probable mutation association

A future manager/tool boundary may associate a specific file-tool mutation with an agent when the path and before/after bytes are both observed around that operation. Concurrent or overlapping writes downgrade confidence to `shared`; shell-generated changes remain `unknown` unless independently delimited. This is probable attribution, not exact authorship.

### Stage 3 — exact attribution

Use `exact` only when isolation or an atomic write boundary proves ownership, for example a dedicated worktree/branch per agent or a backend-provided patch applied by the manager. Worktree isolation and GitButler reconciliation are separate architecture decisions and are not part of observability v1.

Exact claiming of Pi child-extension hook events is likewise deferred until a non-racy per-child API exists. Hunk/GitButler may display or reconcile a captured patch later, but shared-worktree state alone cannot establish authorship.

## 15. Retention, project policy, purge, and export

### 15.1 Project policy

A protected daemon configuration supports longest-root matching:

```json
{
  "defaults": {
    "enabled": true,
    "contentMode": "rich",
    "retentionDays": 30,
    "maxDatabaseBytes": 1073741824,
    "maxSpoolBytes": 67108864
  },
  "projects": [
    { "root": "/path/to/no-capture", "enabled": false },
    { "root": "/path/to/metadata-only", "contentMode": "metadata" },
    { "root": "/path/to/project", "excludePaths": ["private/**"] }
  ]
}
```

- `disabled`: the producer drops project events before disk and daemon rejects them if received.
- `metadata`: lifecycle/timing/status/path classifications are retained, but prompt/message/args/result/patch/structured content is omitted.
- `rich`: bounded and redacted content is retained.

The parent determines policy before capture; the daemon independently enforces it. Runtime policy changes affect new events. Purge removes old data.

### 15.2 Retention and size pressure

Defaults are 30 days and 1 GiB for DB + WAL, plus a separate 64 MiB spool cap. Retention runs at startup and periodically:

1. never prune an active run;
2. delete the oldest settled run groups and their events/agents in bounded transactions until both age and size targets are met;
3. delete old root-session events by the same settled-run grouping;
4. update `minRetainedSeq` and run incremental vacuum/checkpoint work in small idle slices;
5. if disk pressure prevents safe writes or retention cannot meet the cap, switch new rich content to metadata-only, preserve lifecycle when possible, and surface a health warning.

Initial values must be tuned from dogfood measurements, not expanded into more tables in advance.

### 15.3 Purge

Purge is required for a redaction miss but is not a web control in v1.

```text
node companion/daemon.mjs purge --run <id> --yes
node companion/daemon.mjs purge --project <canonical-root> --yes
node companion/daemon.mjs purge --before <ISO-date> --yes
node companion/daemon.mjs purge --all --yes
```

Maintenance mode refuses to run while the daemon owns the lock. Once stopped, it acquires the same lock as the sole writer, marks matching artifact fingerprints `purged` in the protected reconciliation state, deletes matching events/projections in a transaction, checkpoints, and optionally performs bounded incremental vacuum. Unchanged source artifacts therefore do not repopulate purged rows. Purge never follows artifact paths or deletes native source artifacts. Documentation must tell the user that separately persisted native/workflow artifacts may need their own deletion.

### 15.4 Export

The authenticated read API streams already-redacted JSONL. A CLI wrapper may write it to an explicitly chosen file created `0600`. Export includes schema/provenance/redaction/truncation metadata and warns that the file remains sensitive. It never exports pre-redaction source artifacts.

## 16. Failure behavior

| Failure                              | Required behavior                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon absent/startup failure        | Pi continues; redacted bounded events spool; one non-sensitive diagnostic.                                                                     |
| Sink throws or queue is full         | Manager/workflow state continues; coalescable data drops first; counters record loss.                                                          |
| Daemon crashes mid-batch             | SQLite transaction rolls back; producer replays same event IDs.                                                                                |
| Duplicate replay                     | Same stored hash is acknowledged without a second projection update.                                                                           |
| Duplicate ID with different bytes    | Original remains; conflicting event is rejected and counted.                                                                                   |
| Partial/corrupt spool segment        | Replay complete valid lines; quarantine/delete bad tail within cap; never log content.                                                         |
| Producer exits/restarts with backlog | Daemon or next guarded producer adopts foreign immutable segments, replays them idempotently, and GCs acknowledged segments/empty directories. |
| Disk full                            | Stop rich writes, attempt metadata-only lifecycle, retain in memory only within cap, report health; never write an unredacted emergency file.  |
| Migration failure/newer schema       | Daemon unhealthy and producer spools; do not replace/delete DB.                                                                                |
| Node below 22.5 or no `node:sqlite`  | Do not start storage/read services; orchestration continues and producers use the bounded spool only.                                          |
| Projection bug/corruption            | Rebuild `runs`/`agents` from retained events ordered by daemon `seq`.                                                                          |
| Producer clock skew                  | Affects display only; receive sequence and explicit source precedence drive projections.                                                       |
| Artifact missing/malformed/too large | Skip and count by reason; primary events remain authoritative.                                                                                 |
| Redaction failure                    | Reject/drop the payload before any observability disk write; keep reason/count only.                                                           |
| Child deny-path verification fails   | Do not enable rich capture for that backend.                                                                                                   |
| Browser polling cursor pruned        | Return `410` + floor; UI reloads projections.                                                                                                  |

## 17. Tests and evaluations

### 17.1 Contract and reducer tests

- Envelope v1 accepts additive fields and safely stores unknown kinds.
- Maximum-size structured/patch fields fit with the reserved envelope allowance; field overflow truncates without dropping the event, while envelope overflow rejects it.
- Finalized parent assistant/thinking content is represented by `message.assistant`; streaming deltas are not persisted.
- Identity is minted before backend spawn and remains stable through follow-up/resume.
- Workflow-owned agent events are emitted only by manager, never by the workflow run reducer.
- Receive-sequence replay produces identical projections after rebuild.
- Wall-clock skew cannot freeze or overwrite a projection.
- Artifact precedence fills missing facts but cannot overwrite primary fields.
- Duplicate ID/same hash is idempotent; duplicate ID/different hash is rejected.

### 17.2 Storage/migration tests

- Fresh migration, every-version migration, double migration, newer-version refusal.
- Crash/fault injection between event insert and projection update proves atomic rollback.
- WAL restart, checkpoint, quick check, size retention, incremental vacuum.
- Projection rebuild equals live projections for the same retained log.
- Prepared-query and pagination limit tests.

### 17.3 Sink/replay tests

- Daemon down/up, process restart, partial segment, duplicate ACK loss, out-of-order network completion.
- A fresh producer and the daemon each adopt backlog under a dead/foreign `producerId`; duplicate concurrent adoption remains idempotent and acknowledged segments/empty directories are reclaimed.
- Replay-before-live ordering across all producer directories without overtaking filename order within one producer.
- Queue coalescing never drops lifecycle/settlement until the documented hard spool cap is exhausted.
- Spool cap eviction produces a later gap count without preserving payload.
- Observability failure never changes workflow return values, agent status, result delivery, cancellation, or shutdown cleanup.

### 17.4 Security tests

- Startup rejects wrong owner, symlinked state, and insecure modes; DB/WAL/SHM/token/spool modes are verified after use.
- Ingest/read token separation, exact Host/Origin, no CORS, body cap, content type, CSP, stored-XSS fixtures, SQL-injection filters.
- Every backend fails direct, relative, symlink, search, and shell attempts to read token/DB/spool/config.
- Secret-path content omission is tested for read arguments/results, assistant messages, structured results, patches, and mutations.

### 17.5 Redaction leak evaluation

Seed distinctive credentials and private-key fixtures into:

- parent prompt/message;
- agent prompt/message;
- tool arguments and results;
- reads from excluded files;
- structured output;
- patch/mutation payload;
- unknown event kind;
- producer spool and replay;
- workflow/shared artifact import;
- values that cross a truncation boundary.

After ingest/restart/reconcile/export, scan the DB, WAL/SHM where readable, spool, logs, new run artifacts, UI/API responses, and export. No seeded plaintext may appear. Also assert every stored string length is within cap and every redaction marker survives the second scan. Existing native artifacts are reported separately so the evaluation does not falsely claim they were rewritten.

### 17.6 End-to-end acceptance

Run a parent Pi session containing standalone and workflow-owned Pi/Claude/Codex agents, follow-up, cancellation, schema success/failure, workflow phase/log/error, daemon outage/restart, and artifact recovery. Verify one coherent timeline, no duplicate automatic result delivery, and unchanged current smoke/startup checks.

## 18. Delivery sequence, gates, and rollback points

No D phase may begin until the C1 one-vocabulary gate passes.

### C0 — contracts, durable identity, and workflow run events

Status: not started. The already-landed Task C workflow metadata, manager wait/get, and delivery-suppression seams are groundwork, not C0 completion and not evidence that workflow execution uses the manager.

Implement:

- stable IDs/envelope types and a no-op sink interface;
- manager allocation of durable run/agent identity before backend spawn;
- workflow events limited to run-level phase, log, and settle;
- existing `WorkflowDetails` and manager snapshots as in-memory projections;
- preserve and formalize the existing parent/child origin groundwork needed by C1, without a daemon or database;
- leave `extensions/shared/dashboard-state.ts` untouched and do not reuse it for observability: it is an unrelated model/git dashboard channel utility, not a run/agent projection. Any dead-code deletion belongs to a separate cleanup.

Acceptance gate:

- existing behavior and tests remain unchanged with a no-op sink;
- parallel spawns cannot start backend work before manager identity exists;
- C0 has no workflow-agent lifecycle event kind;
- no model-visible API is introduced.

Rollback: remove/disable the additive sink and ID plumbing. There is no persisted format yet.

### C1 — unify workflow agents and retire the legacy runner

Status: not started; workflow `agent()` still executes through the legacy Pi-only runner.

Implement all existing Task C requirements:

- route workflow `agent()` through `SubagentManager`;
- support `harness`, model, effort, and schema across Pi/Claude/Codex;
- have the workflow bridge consume the existing `origin: "workflow"`, `workflowRunId`, workflow phase/index/label, and forced `autoDeliver: false` groundwork before spawn;
- await manager settlement and return `{ ok, output, structured?, error? }` to the script;
- keep per-agent status/preview/usage/transcript visible in `/workflows` and show workflow ownership in `/subagents`;
- propagate workflow cancellation to manager cancellation;
- suppress standalone parent follow-up/result delivery for workflow-owned agents;
- remove the old workflow child execution path and any fallback flag/code.

Acceptance gate:

- all harnesses work in workflow scripts;
- no duplicate parent follow-up;
- cancellation and shutdown settle manager-owned children;
- workflow explicit returns remain the source of truth;
- tests prove only manager event kinds represent workflow agents;
- repository search and tests prove the legacy runner cannot execute an agent.

Rollback: revert C1 as one unit before D1. Do not retain both paths for a soak period, and do not start D work until C1 is accepted.

### D1 — minimal daemon, schema, and projections

Implement:

- one companion process, lock/state/permission checks, SQLite WAL, migration v1;
- exactly `events`, `runs`, and `agents` application tables;
- ingest validation, mandatory daemon re-redaction, daemon sequence assignment, idempotent inserts, and projection reducers;
- rebuild/status maintenance commands and storage tests.

Acceptance gate:

- sequence/replay/migration/fault tests pass;
- no content is accepted unless all persisted bytes were scanned;
- no external blob tier or extra normalized table is added without dogfood evidence.

Rollback: stop/disable the daemon and remove an opt-in test DB. Runtime orchestration remains unchanged because the sink is still no-op or disconnected.

### D2 — Pi hooks, manager sink, autostart, and protected spool

Implement:

- root Pi lifecycle/tool/message hooks;
- manager and workflow-run sink taps;
- producer redaction/bounds, batching/coalescing, protected spool, replay;
- subagents-owned autostart and bounded shutdown flush;
- per-project disable/metadata/rich policy;
- child protected-path integration and mode/ownership verification.

Acceptance gate:

- daemon outage does not affect agents/workflows;
- replay is idempotent and receive ordered;
- cross-backend child deny-path tests pass or rich capture remains disabled for the failing backend;
- the redaction leak evaluation passes for live ingest and spool.

Rollback: one local configuration switch disables capture/autostart and leaves manager/workflow behavior intact. It must not re-enable the legacy workflow runner.

### D3 — read API, polling UI, and dogfood entry

Implement:

- authenticated read routes and read-token separation;
- static no-build UI with run, timeline, agent, and health views;
- cursor polling and retention-floor resync;
- browser/HTTP hardening.

Acceptance gate:

- no browser-facing mutation/control route exists;
- stored-XSS, CORS/Host/Origin, token-scope, query, and polling-resync tests pass;
- the tool can be dogfooded without SSE.

Rollback: stop serving static/read routes while ingestion/storage continues, or disable the daemon entirely through the D2 switch.

### D4 — redacted artifacts, reconciliation, retention, purge, and export

Implement:

- shared redacted run/result/transcript artifacts for standalone and workflow-owned agents;
- durable structured results, closing `TASK-D-001`;
- idempotent bounded workflow/shared artifact reconciliation and role enrichment;
- age/size retention, metadata-only pressure mode, offline purge, and redacted export.

Acceptance gate:

- crash recovery creates marked recovered projections without overriding primary facts;
- repeated reconciliation inserts no duplicates;
- new artifacts pass the same leak evaluation as DB/spool;
- retention meets both time and byte caps; purge removes selected rows and export contains only stored redacted data.

Rollback: disable artifact writing/reconciliation/maintenance scheduling independently. Existing event ingestion remains usable; source artifacts are never modified by reconciliation.

### D5 — measured hardening and honest change summaries

After a real dogfood period, use measured DB growth, query patterns, redaction counts, and UI latency to tune caps/indexes. Only then consider Stage 1 shared/unattributed changed-file summaries.

Acceptance gate:

- the timeline is useful without a schema expansion;
- any change summary is labelled `shared/unattributed` under overlap and omits secret-path hashes/content;
- no claim of exact agent authorship exists.

Rollback: disable change-summary capture. Do not remove core timeline data or rewrite the schema.

### E — supervisor UX hardening

Preserve existing Task E requirements:

- show roles in rows/headers;
- distinguish retryable provider errors visually when possible without adding a new lifecycle state;
- resume inactive roles from the dashboard;
- verify Pi/Claude/Codex mid-run steering;
- show queued follow-ups;
- add non-model-visible links from TUI run/agent views to the read-only web detail when available;
- make redaction/truncation/recovery/gap status visible without turning the TUI into a second query engine;
- close `TASK-E-001` if a dedicated structured-output badge proves useful.

Acceptance gate:

- TUI actions still use live manager state, not the observability DB;
- web failure never disables supervision;
- no web controls are added as part of E.

Rollback: remove web links/badges while preserving the existing `/subagents` and `/workflows` dashboards.

## 19. Global acceptance gates

The first release is not accepted until all are true:

- C1's legacy path is gone before D1 lands.
- Root Pi hooks and the unified manager are the primary producers; artifacts are visibly secondary.
- Daemon projections are deterministic under `ORDER BY seq` and rebuild cleanly.
- The daemon re-redacts all known and unknown payloads using redact → bound → re-scan.
- Token/DB/spool/config paths are inaccessible to supported child tools for every rich-enabled backend.
- Per-project disable/metadata policy works at producer and daemon.
- Age, DB, and spool caps are enforced; purge and export are documented and tested.
- Polling UI is useful without SSE.
- Redaction leak and stored-XSS evaluations pass.
- `npm test`, `npm run format:check`, `npm run smoke`, and `PI_OFFLINE=1 pi --list-models` pass for implementation changes.

## 20. Deferred roadmap

These items require a new decision after v1 dogfood, not placeholder implementation now:

- native Pi/Claude/Codex artifact adapters, including the optional secondary Moshi projection importer described in §21;
- SSE based on measured polling limitations;
- normalized message/tool/usage tables driven by proven queries;
- content-addressed blobs or object storage driven by measured DB pressure;
- exact mutation/diff attribution through isolation or atomic patch ownership;
- Unix sockets;
- independent local Claude/Codex/CI producers;
- remote producers, which require a separate TLS/auth/threat-model design;
- PostgreSQL. The portable boundary is the envelope plus pure projection reducer, not prewritten Postgres SQL.

Any future adapter must obey the same envelope versioning, stable IDs, receive ordering, full daemon redaction, project policy, and source-precedence rules.

## 21. Moshi Hook 0.3.0 reference and interoperability

### 21.1 Evidence boundary

Verified against the installed `moshi-hook version 0.3.0`, Moshi's public Hooks/Chat View/usage documentation, and the installed files generated by `moshi-hook install`:

- Moshi installs agent-specific adapters for Pi, Claude Code, Codex, OpenCode, Gemini/Antigravity, and other supported CLIs. They do not expose one uniform native hook surface. The generated Pi adapter captures session start/end, user prompt, agent start/settle, model, context remaining, last assistant summary, and native transcript path. The generated OpenCode adapter currently has the richest observed lifecycle, tool, approval, transcript-relay, and tmux/Herdr/Zellij terminal-context integration.
- Routine hook delivery uses a local Unix socket; the daemon also serves the phone-facing loopback gateway on `127.0.0.1:24543`. Failures are intentionally graceful. Full transcript/diff access remains local or travels directly through the host gateway, while cloud traffic contains compact session/approval summaries and bounded prompt/assistant excerpts. Usage/rate-limit polling is a separate optional daemon feature.
- The local per-session JSON files are compact latest-state projections: one file is updated for a session, matching Moshi's one-active-row presentation. They are not a durable event log and cannot support complete replay or timing reconstruction.

The generated adapters and public behavior above are evidence; private Go implementation details, undocumented socket messages, and private schemas are not. Any statement about those internals is an inference and must not become a dependency.

### 21.2 Reuse without coupling

Reuse the concepts of graceful failure, per-agent adapters, a one-row latest-state projection, terminal Herdr/tmux/Zellij context, transcript pointers, the local/cloud privacy split, and separate usage polling. Do **not** import, mirror, or depend on Moshi's private binary, socket protocol, or state schema.

An optional future Moshi session projection importer may discover external sessions and native transcript paths. It is always secondary and lossy, emits `artifact.*` provenance, passes through our bounds/policy/redaction pipeline, and never overrides Pi-hook or manager facts. Moshi does not replace our durable event log, tool timings, workflow hierarchy, structured artifacts, search/replay, diff attribution, or redaction.

Same-UID child agents may otherwise reach the Moshi socket/state, so §11's future canonical protected-path policy includes those configured locations. Moshi cloud summaries may contain bounded prompt and assistant excerpts; interoperability must never forward our richer event payloads to Moshi or treat its cloud channel as an observability export.

## 22. Architecture-review disposition

| Review item                   | Disposition                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tool correlation              | `tool_call_id` is a nullable `events` column with a partial sequence index (§10).                            |
| Polling without a global feed | Detail views use scoped feeds; list/status views refresh projections (§12).                                  |
| IDs in filesystem paths       | External IDs stay opaque; only grammar-validated locally minted IDs may be one contained path fragment (§6). |
| Runtime degradation           | Node 22.5+/`node:sqlite` is required for the daemon; otherwise producers remain spool-only (§5, §16).        |
| Shared redaction              | One dependency-free `.mjs` implementation serves Pi and bare Node (§11).                                     |
| C0 dashboard utility          | `dashboard-state.ts` is not reused or removed by C0 (§18).                                                   |
| Incomplete projections        | Initialize at zero in memory and persist the triggering event sequence atomically (§10).                     |
| Task C integration risks      | Deferred implementation guards are tracked in `BUGS.md`; groundwork does not mark C0 or C1 complete.         |
| Moshi interoperability        | Conceptual reuse and a future secondary importer only; no private-protocol dependency (§21).                 |
