# D2 adversarial test plan (read-only review artifact)

Status: adversarial inventory used during the completed D2 implementation.
The numbered cases remain a regression/expansion checklist; deterministic D2
unit and subprocess coverage now implements the release-critical normalization,
policy, queue/spool/replay, autostart, hook, shutdown, path-fallback, and scope
gates. Expensive backend/model-specific cases remain live acceptance exercises,
not evidence that rich capture is safe: production is forced to metadata-only
until every enabled backend has a real same-UID shell/read boundary.

This file began as a read-only red-team proposal. The implementation status and
accepted deviations are authoritative in `docs/observability-architecture.md`,
`MULTI_AGENT_HANDOVER.md`, and `BUGS.md`.

Grounding read: D1 accepted primitives that D2 must reuse or extend —
`companion/src/fsguard.mjs` (0700/0600, symlink/uid/mode verification),
`companion/src/lock.mjs` (dead-PID + startToken compare-checked reclaim),
`companion/src/metrics.mjs` (accepted/duplicate/conflict/rejected/batches/
projectIdMismatch/truncations/rejectedByReason/redactionByClass — no gap
counter yet), `companion/src/home.mjs` (companion tree paths),
`companion/src/ingest/validate.mjs` (envelope: `v`, `eventId`, `kind`,
`schemaVersion`, `occurredAt`, `producer{id,seq,kind}`,
`ids{traceId,runId,parentRunId,agentId,turnId,toolCallId}`, `payload`,
`capture{contentMode: rich|metadata|disabled, truncated, truncatedFields,
fieldBytes{original,stored}}`, `project{id,root}`), `extensions/shared/
redaction.mjs` (rule classes: header/cookie/secretField/privateKey/token/
credentialUrl, exact `[REDACTED:kind]` markers, PEM index-scanner, JSON key
suppression), `extensions/shared/observability/sink.ts` (sync non-throwing
`emit`, `flush(budgetMs)`, `NOOP_OBSERVABILITY_SINK`), `extensions/shared/
child-session.ts` (existing child extension-path/tool denylist — D2 must add
a filesystem-level deny-path layer, since none exists yet per `OBS-D-002`).

Two known D1 carry-over defects to re-verify are NOT re-broken by D2:

1. `ensureCompanionTree`/`secureDirectory` check-then-mkdir TOCTOU on virgin-home
   concurrent starts (previously raw EEXIST at exit 70).
2. `nextReceivedAt` monotonic clock skew vs wall time (ordering via `seq` only).

## 1. Daemon absent / start / restart / concurrent Pi processes

- D2-DAEMON-001: Pi starts with no companion home at all (first run ever) —
  subagents' `ensureDaemon()` creates the tree, acquires the lock, and the
  first hook-driven event is accepted; no agent/workflow lifecycle is delayed
  or blocked waiting on daemon readiness (fire-and-forget spool write, not a
  synchronous ingest call).
- D2-DAEMON-002: Daemon binary/runtime unavailable (Node < 22.5, or
  `node:sqlite` unconstructible) — `ensureDaemon()` observes the D1 machine
  exit code 69 from a probe/spawn attempt and disables capture for the
  session without throwing into agent/workflow code paths.
- D2-DAEMON-003: Two Pi processes start concurrently against the same
  `~/.pi/agent` (two terminals) — exactly one wins `acquireDaemonLock`; the
  loser's `ensureDaemon()` treats `LockHeldError` as "already running,"
  verifies the live daemon via `/healthz`, and proceeds to spool/replay
  against the winner. No second daemon process, no crash, no duplicate port
  bind attempt visible to the user.
- D2-DAEMON-004: Daemon killed with SIGKILL mid-batch (torn WAL) while a Pi
  session keeps running — the session's producer keeps queuing/spooling;
  next `ensureDaemon()` call (from a hook tick or a new spawn) detects the
  dead PID via the existing dead-PID lock reclaim, restarts, replays the
  spool, and no in-flight agent/workflow is affected.
- D2-DAEMON-005: Daemon restarted with a _different_ protocol/build version
  mid-session (simulated upgrade) — spooled envelopes carry `v: 1` and are
  replayed successfully, or rejected with `unsupported-envelope-version`
  without crashing the producer or orchestration.
- D2-DAEMON-006: Three or more concurrent Pi processes (stress) each spawn
  standalone + workflow agents simultaneously — assert single daemon PID
  throughout, no lock file corruption, no lost lock ownership flapping
  between processes (thundering-herd re-acquire).
- D2-DAEMON-007: `ensureDaemon()` called reentrantly from both a root Pi hook
  and a workflow-owned agent's manager tap in the same tick — assert it is
  idempotent/coalesced to one real start attempt (matches the plan's "one
  guarded `ensureDaemon()` lifecycle; workflows never start a second
  daemon").

## 2. Queue overflow / coalescing

- D2-QUEUE-001: Burst of events beyond the in-memory queue high-water mark
  (e.g., 10k tool-call events in <1s from a wide workflow fan-out) — producer
  drops or coalesces deterministically (oldest-first or explicit
  coalescing rule), increments a `capacity`-style dropped counter (mirrors
  `RecordingSinkStats.droppedByReason`), and never blocks the emitting
  hook/tool call.
- D2-QUEUE-002: Coalescing merges same-kind/same-turn events (e.g. repeated
  tool-call progress deltas) — verify the merged/coalesced envelope still
  passes `validateEvent` and that coalescing never merges two different
  `eventId`s into one stored fingerprint (breaks D1 idempotency semantics).
- D2-QUEUE-003: `flush(budgetMs)` is called with an artificially small budget
  during shutdown while the queue still has thousands of pending events —
  assert flush respects the budget (returns before `budgetMs` elapses by a
  bounded margin) rather than blocking process exit indefinitely.
- D2-QUEUE-004: Rapid producer-seq overflow (`producer.seq` wrapping/growing
  past `Number.MAX_SAFE_INTEGER` in a long-running session) — assert graceful
  rejection/rollover handling, not an `invalid-producer-seq` cascade that
  silently drops all subsequent events.
- D2-QUEUE-005: Interleaved standalone + workflow events from the same
  process compete for one bounded queue — assert no starvation (a wide
  workflow cannot starve standalone agent lifecycle events indefinitely) and
  no cross-run event ordering corruption once persisted (still `ORDER BY
seq` deterministic per D1 acceptance).

## 3. Partial / corrupt / foreign spool

- D2-SPOOL-001: Spool file truncated mid-write (simulated crash during
  `fs.writeFileSync`) — daemon/producer replay skips the truncated record
  deterministically (e.g. length-prefixed or newline-delimited framing with a
  bounded-size guard) without throwing an unhandled rejection or blocking
  subsequent valid records.
- D2-SPOOL-002: Spool file contains a batch with an out-of-range/negative
  declared length or non-UTF-8 bytes — rejected as a corrupt record, counted,
  and skipped; does not crash the replay loop or leak raw bytes into logs.
- D2-SPOOL-003: A spool file is replaced with a symlink pointing outside the
  companion tree (foreign file swap attack) — replay must reuse
  `fsguard.assertNoSymlink`/`secureFile` semantics and refuse to read through
  the symlink (matches D1's `symlink-rejected`, exit 71).
- D2-SPOOL-004: A "foreign" spool file is dropped into the spool directory by
  another UID-owned process or crafted externally (not written by this
  producer) — file ownership/mode verification (`secureFile`, uid check)
  rejects it before parsing; it is never silently ingested as if it were a
  trusted local envelope.
- D2-SPOOL-005: Spool contains an envelope with `v` != 1 or an unknown
  `capture.contentMode` value mixed among valid ones in the same file —
  assert per-record isolation: one bad record does not poison the whole
  batch/file replay.
- D2-SPOOL-006: Two spool files claim the same on-disk name via a race
  (concurrent flush from same producer under clock skew) — atomic
  temp+rename (per `workflows/serialization.ts` pattern) prevents partial
  overwrite; replay never double-ingests or drops the loser.
- D2-SPOOL-007: Spool directory pre-populated with thousands of stale files
  from a killed prior session — restart replay is bounded in time (does not
  block startup indefinitely) and processes files in a defined order
  (oldest-first) so gap detection stays meaningful.
- D2-SPOOL-008: Disk write returns success but `fsync` is skipped/fails
  (simulate ENOSPC on fsync only) — spool entry is not falsely considered
  durable; replay-on-restart still recovers it if the file bytes exist, and
  metrics do not claim "batches" accepted that were never fsynced.

## 4. ACK loss / replay-before-live

- D2-ACK-001: Daemon accepts a batch, persists it, but the HTTP response is
  lost before the producer sees it (simulated connection reset after
  server-side commit) — producer replays the same spooled batch; daemon-side
  idempotency (existing D1 fingerprint dedup) makes the replay a no-op
  (`duplicate`/`conflict` metrics increment, not double-counted `accepted`).
- D2-ACK-002: Producer crashes after writing to spool but before receiving
  any ACK, then restarts — on next `ensureDaemon()`, the unacknowledged
  spooled batch is replayed exactly once observed downstream (idempotent),
  never silently dropped as "probably already sent."
- D2-ACK-003: "Replay-before-live" ordering — spooled (historical) envelopes
  and newly produced (live) envelopes are both eligible to send at daemon
  reconnect; assert replay of the spool completes (or is at least
  sequenced/interleaved deterministically) before/with live events such that
  daemon `received_at`/seq ordering does not present live events as older
  than not-yet-replayed history in a way that corrupts run/agent timelines.
- D2-ACK-004: Partial-batch ACK — daemon accepts 8 of 10 events in a batch
  (2 fail validation) and returns a per-event result — producer must not
  re-spool/replay the 8 accepted ones as if the whole batch failed, and must
  retry only the 2 rejected (or drop them per policy, not retry forever).
- D2-ACK-005: Network partition longer than several flush cycles, then
  recovery — verify bounded spool growth (caps apply, see §5) and that once
  connectivity returns, replay drains the backlog without re-ordering already
  -durable daemon-side sequence numbers.

## 5. Disk full / caps

- D2-DISK-001: Spool directory hits its configured byte cap mid-session —
  producer must apply a defined policy (drop-oldest, refuse-new, or
  degrade-to-metadata) rather than an unhandled `ENOSPC`/exception bubbling
  into orchestration; policy choice is observable via metrics.
- D2-DISK-002: `ENOSPC` on the real filesystem (simulated via a size-limited
  tmpfs or quota) while writing a spool file — write is atomic-or-nothing
  (no half-written file survives), producer disables capture gracefully
  (matches D2 rollback: "one local configuration switch disables capture...
  leaves manager/workflow behavior intact").
- D2-DISK-003: Daemon-side DB/WAL growth cap reached while spool keeps
  producing — daemon must reject/pressure-shed before disk fills completely,
  and must not corrupt the WAL writer; producer must not retry-storm against
  a full daemon.
- D2-DISK-004: Companion home directory itself becomes read-only mid-session
  (permissions changed externally) — write attempts fail closed with a
  `SecurityError`-class error, not a crash; agent/workflow execution
  continues unaffected.
- D2-DISK-005: Spool cap enforcement interacts correctly with in-flight
  replay — evicting an old spool file for cap reasons must not evict one
  that is mid-replay/mid-fsync (no partial-record eviction race).

## 6. Redaction leak corpus

Seed corpus must include, at minimum, one fixture per class below, each
verified absent (byte-for-byte, not just marker-shaped) from: producer spool
files, daemon DB/WAL/SHM, daemon logs, metrics/counters file, and any
HTTP/ingest response body.

- D2-REDACT-001 (rule coverage): live secrets for every existing rule —
  `Authorization`/`Proxy-Authorization` header, `Cookie`/`Set-Cookie`,
  bearer token, `password=`/`token:`/`api_key=` assignment (quoted,
  single-quoted, bare), PEM private key block (RSA/EC/OPENSSH labels,
  mismatched BEGIN/END label, unterminated block), GitHub `ghp_`/
  `github_pat_`, AWS `AKIA…`/`ASIA…`, npm `npm_…`, Slack `xox[baprs]-…`,
  OpenAI `sk-…`/`sk-proj-…`, JWT three-segment token, credential URL
  (`scheme://user:pass@host`).
- D2-REDACT-002 (truncation boundary interaction): a secret value that
  straddles the exact truncation boundary the producer applies before disk
  (e.g., a 4096-byte-limited `SECRET_ASSIGNMENT` value cut at byte 4095/4096/
  4097, and a bearer token cut mid-base64) — assert truncation happens
  _after_ redaction (redact → bound → re-scan per architecture doc, never
  bound → redact, which could truncate away the pattern match and leak a
  half-token) and that UTF-8 boundary splitting never slices inside a
  multi-byte character to produce replacement-char corruption that hides a
  secret from re-scan.
- D2-REDACT-003 (unknown kinds): an event `kind` never seen by the redaction
  rule set, with payload shapes the daemon does not specifically know about
  (e.g., a future tool-call kind with nested arrays of objects containing a
  `client_secret` key three levels deep, or a top-level array of raw
  strings) — assert the generic recursive JSON redactor still walks and
  redacts it; an unrecognized `kind` must never bypass `redactJson`/
  `redactString` entirely.
- D2-REDACT-004 (secret-field subtree suppression under D2 payload shapes):
  a `payload.arguments.password` whose value is an _object_ or _array_
  (not a string) — assert the whole subtree is suppressed, not skipped
  because the field-name rule only fires on direct string children (a named
  D1 review anti-pattern: "Field-name JSON redaction firing only on direct
  STRING children leaks secret-named keys holding arrays/objects").
- D2-REDACT-005 (bypass-guard anti-pattern): payload strings that already
  _contain_ the literal text `[REDACTED:token]`/`[REDACTED:secret-field]`
  adjacent to or interleaved with a real, distinct secret — assert the
  marker-skip logic only matches when the captured secret segment IS exactly
  a marker (not merely `.includes("[REDACTED:")`), so an attacker cannot
  smuggle a real secret past redaction by prefixing/suffixing a fake marker
  string.
- D2-REDACT-006 (read secret paths / file-content capture): if D2's rich
  capture ever mirrors file-read tool results or shell command output, feed
  it the contents of `~/.ssh/id_ed25519`, `.env` with `AWS_SECRET_ACCESS_KEY=`,
  and `~/.netrc` — assert the daemon-stored/spooled record contains no
  live key material even though the source read was legitimate application
  behavior (this is the redaction boundary, not a path-block boundary).
- D2-REDACT-007 (double/second-scan defeat attempt): a payload engineered so
  that the _first_ redaction pass's marker insertion creates a new
  substring that itself looks like a secret pattern to a _naive_ single-pass
  scanner (e.g., inserted marker text next to base64 that only becomes
  JWT-shaped after concatenation) — assert the required full second re-scan
  (redact → bound → re-scan) still catches secrets only revealed after
  truncation/boundary changes, and does not itself introduce a new leak from
  marker text.
- D2-REDACT-008 (Unicode adversarial): lone surrogate immediately before or
  after a secret substring, zero-width joiners inside a token, and secrets
  using fullwidth/confusable Unicode variants of `Bearer`/`Authorization`
  — assert lone-surrogate rejection at the validation boundary
  (`hasLoneSurrogate`) still applies to _content_ fields the same as IDs, and
  that confusable-Unicode variants are an accepted non-goal (only exact ASCII
  rule matches are guaranteed) rather than silently claimed as covered.
- D2-REDACT-009 (producer/daemon parity): the same corpus run through the
  producer-side pre-spool redaction and the daemon-side re-scan must be
  idempotent — running redaction twice must not alter an already-redacted
  value (exact marker idempotency) and must not double-count a rule in
  `metrics.redactionByClass` for content redacted once by the producer and
  once by the daemon re-scan (or, if double-counting is the deliberate
  design, this must be an explicit, documented, tested choice, not an
  accidental one).

## 7. Producer vs daemon policy mismatch

- D2-POLICY-001 (`OBS-D-006`): producer sends `capture.contentMode: "rich"`
  for a project the _daemon_ independently classifies as disabled — daemon
  rejects the event (not merely downgrades it), matching "independently
  reject disabled-project events."
  the plan's requirement that producer policy is advisory-only.
- D2-POLICY-002: producer sends `rich` for a project the daemon has
  configured as `metadata`-only — daemon forces metadata-only storage
  (drops/omits payload content fields) regardless of producer intent, and
  records this as a policy-forced downgrade in metrics, not a silent
  no-op.
- D2-POLICY-003: producer is compromised/buggy and sends `contentMode:
"rich"` alongside a fabricated/absent `project` block to evade project
  policy lookup — daemon must not default to "rich" when project
  attribution is missing or fails re-derivation; fail closed to
  metadata/disabled.
- D2-POLICY-004: producer and daemon compute different `project.id` for the
  same `project.root` (already covered by D1's `projectIdMismatch` metric)
  combined with a rich-capture request — assert the mismatch path forces the
  safer (lower-capture) policy, not the producer's requested one.
- D2-POLICY-005: mid-session policy change (project disabled while agents
  are still running) — already-spooled-but-not-yet-replayed rich events from
  before the change: verify daemon applies _current_ policy at ingest time
  (not policy-at-producer-send-time), so a project disabled mid-run cannot
  have its late-arriving spool backlog accepted as rich.

## 8. Project disabled / metadata / rich, longest-root

- D2-PROJECT-001: nested project roots — `/repo` configured `metadata`,
  `/repo/packages/app` configured `rich` — assert longest-matching-root wins
  (an agent cwd'd into `/repo/packages/app` gets `rich`, one cwd'd at
  `/repo` or `/repo/packages/other` gets `metadata`).
- D2-PROJECT-002: no configuration entry matches any ancestor of cwd —
  assert a safe default (metadata or disabled, whichever the plan specifies
  as the fail-safe default) rather than defaulting to rich.
- D2-PROJECT-003: project root config uses a path with a trailing slash /
  different casing / symlinked path vs the real cwd — assert root matching
  is realpath-normalized consistently on both producer and daemon sides so
  they cannot disagree about which policy applies to the same physical
  directory.
- D2-PROJECT-004: a workflow agent's cwd is restricted/sandboxed
  differently from the parent project root (workflow `cwd` DSL feature) —
  assert policy resolution uses the _agent's actual_ cwd, not the parent
  session's, so a workflow deliberately scoped to a stricter subtree cannot
  inherit a laxer ancestor policy it shouldn't have, and vice versa a
  workflow cannot escape a disabled-project ancestor by operating in an
  unlisted sibling directory that resolves under the same disabled root.
- D2-PROJECT-005: project disabled entirely — assert _zero_ envelopes are
  spooled/sent for that project's events (not merely metadata-scrubbed), if
  that is the documented "disabled" semantics; confirm which of "no event at
  all" vs "lifecycle-only, zero content" the D2 implementation actually
  chose, and test that exact behavior explicitly (do not assume).

## 9. Protected path enforcement across Pi/Claude/Codex

For every backend (Pi native child, Claude Code child, Codex child) and every
protected target (companion root, spool dir, logs dir, lock file, state file,
ingest/read tokens, metrics file, database + `-wal`/`-shm`, and — new in D2 —
existing workflow artifacts and new run artifacts per the architecture doc),
test each access vector:

- D2-CHILDPATH-001 (direct absolute path): child reads/writes the protected
  path via its resolved absolute form using the backend's file-read/file-
  write/shell tool.
- D2-CHILDPATH-002 (relative path): child expressed as a path relative to its
  own cwd that resolves (via `..` segments) into the protected tree.
- D2-CHILDPATH-003 (symlink indirection): a symlink created inside the
  child's writable cwd pointing at the protected path, then read/written
  through the link (must be blocked even though the _link_ itself is inside
  an allowed directory).
- D2-CHILDPATH-004 (glob/wildcard): a shell glob or tool `path` pattern that
  would enumerate into the protected tree as one match among many allowed
  files (e.g. `~/.pi/agent/multi-agent/**` from a broad recursive read),
  verifying the deny check applies per-resolved-match, not just to a
  literally-typed protected path.
- D2-CHILDPATH-005 (shell indirection): shell tool commands that reach the
  protected path indirectly — `cat "$(echo ~/.pi/agent/multi-agent/...)"`,
  environment-variable expansion, `readlink`/`realpath` chains, `cp -r` of an
  ancestor directory that contains the protected subtree, tar/zip of a
  parent directory.
- D2-CHILDPATH-006 (case/Unicode/NFC-NFD variants on case-insensitive or
  Unicode-normalizing filesystems, if applicable): path variants that
  resolve to the same protected inode via case-folding or normalization.
- D2-CHILDPATH-007 (race): child creates its own file, then the _parent_
  process (or a concurrent daemon write) causes that path to later resolve
  into a protected location via a TOCTOU rename/symlink swap after an
  initial allow-check but before actual access — verify the deny check is
  applied at actual-open time (realpath at access), not only at
  request-declaration time.
- D2-CHILDPATH-008 (per-backend fallback): for any backend where the deny
  mechanism cannot be enforced with confidence (per architecture doc's
  cross-backend acceptance gate: "cross-backend child deny-path tests pass
  or rich capture remains disabled for the failing backend") — assert rich
  capture is actually disabled for that specific backend rather than the
  gate being silently skipped.
- D2-CHILDPATH-009: repeat 001-004 for _workflow-owned_ children in addition
  to standalone children, since workflow `cwd` can differ from the standalone
  default and workflow artifacts (`workflows/artifacts.ts` output) are
  explicitly listed as a new D2 protected target.

## 10. Child same-UID socket/token access

- D2-CHILDTOKEN-001: a child process running as the _same OS user_ (same
  UID) as the daemon — since `fsguard`'s uid check cannot distinguish parent
  Pi from a same-UID child by UID alone, verify the actual isolation
  mechanism is path-based (denylist/sandboxing per §9), not uid-based, and
  document/test that a same-UID child with unrestricted shell access is
  the honest threat-model boundary (child tool policy / sandbox scope, not
  the daemon's own fs permission check).
- D2-CHILDTOKEN-002: child attempts to read the ingest or read token file
  directly to forge its own `/v1/ingest` request to the daemon (bypassing
  the producer library entirely) — verify this is blocked by the path-deny
  layer (§9), and additionally verify that _if_ a same-UID child obtains
  network access to the daemon's ephemeral loopback port without the token,
  daemon-side auth (existing exact-Host + token check from D1) independently
  rejects it.
- D2-CHILDTOKEN-003: Codex sandboxed child (restricted filesystem/network
  per Codex sandbox requirements referenced in the architecture doc) —
  verify it cannot reach the daemon's loopback port or token file at all
  under default sandbox settings, and that D2 does not silently punch a
  hole in the Codex sandbox to enable capture.
- D2-CHILDTOKEN-004: child spawns its own subprocess that inherits
  environment variables — verify no daemon token/port/path is leaked via
  an inherited environment variable into child/grandchild processes.

## 11. No lifecycle impact from sink failure

- D2-SINKFAIL-001: sink `emit()` implementation throws synchronously —
  `safeEmit`-style wrapping must swallow it; the originating hook/manager
  call must complete normally and the agent/workflow lifecycle event that
  triggered it must still reach its normal (non-observability) side effects.
- D2-SINKFAIL-002: sink `flush()` never resolves (hangs) during shutdown —
  bounded shutdown flush (per D2 plan: "bounded shutdown flush") must time
  out and allow process exit; verify actual wall-clock bound, not merely
  that a timeout constant exists in code.
- D2-SINKFAIL-003: spool write throws `EACCES`/`ENOSPC`/`EROFS` synchronously
  inside a hook handler — assert the exception cannot propagate up through
  the hook dispatch path into agent/workflow control flow (no unhandled
  rejection crashing the Pi process, no observable agent-visible error).
- D2-SINKFAIL-004: daemon is completely down for an entire long-running
  workflow (hours) — assert workflow completes with identical
  results/artifacts as if observability were fully disabled; diff workflow
  outputs with-daemon vs daemon-down for the same deterministic script.
- D2-SINKFAIL-005: repeated sink failures produce repeated stack traces/logs
  — assert no unbounded log growth or performance degradation from retry
  storms against a dead daemon (backoff exists and is bounded).

## 12. Parent hook ordering / messages / tools / context

- D2-HOOK-001: root Pi lifecycle hooks (session_start, agent_start/settle,
  tool call, session_shutdown) fire in the same relative order observability
  ingestion assumes — assert out-of-order arrival (e.g. a tool-result event
  ingested before its tool-call event, possible under concurrent async hook
  dispatch) is handled by daemon-side ordering (`seq`), not assumed
  monotonic-by-content-order.
- D2-HOOK-002: message content capture respects the same metadata-only vs
  rich policy as tool capture — assert a `metadata`-policy project never
  receives full user/assistant message text in any hook-sourced event, only
  bounded previews/hashes, matching C0's existing "metadata-only
  message/tool capture" baseline that D2 must not regress.
- D2-HOOK-003: tool-call event capture for a tool whose arguments/results
  are themselves large binary or non-UTF8-safe content (e.g. an image tool
  result) — assert bounds/redaction/`contentUnavailable` fallback (per
  architecture doc §"Current SubagentEvent tool fields...") applies rather
  than crashing the hook or emitting invalid UTF-8 into the envelope.
- D2-HOOK-004: context/turn identity — `ids.turnId`/`ids.toolCallId`
  consistency across a multi-tool-call turn, including a turn that spans a
  provider retry (same logical turn, backend-retried) — assert IDs remain
  stable/attributable and do not fork into duplicate turns in projections.
- D2-HOOK-005: hook fires during a session that itself has no active project
  root (e.g. Pi launched with `--no-extensions` style minimal context, or
  outside a trusted project) — assert graceful default-policy handling (see
  §8 D2-PROJECT-002) rather than a hook-dispatch exception.
- D2-HOOK-006: two hooks fire concurrently for two independent Pi sessions
  in the same OS user sharing one daemon — assert event `ids`/`producer.id`
  correctly disambiguate the two sessions' runs/agents in projections (no
  cross-session run/agent ID collision).

## 13. Shutdown / reload

- D2-SHUTDOWN-001: `/reload` or extension hot-reload while the daemon
  connection/owner-token/epoch is live — per the architecture doc's
  `Symbol.for` global registry with "one live owner token and epoch guard,"
  assert reload invalidates the old handle, aborts in-flight consumers, and
  a fresh handle is established without duplicate daemon starts or an orphaned
  spool writer left running against a stale epoch.
- D2-SHUTDOWN-002: session replacement mid-flush — assert the bounded
  manager/runtime cleanup described in the architecture doc actually
  completes (or times out safely) before the new session's producer starts,
  so two epochs never write to the spool concurrently.
- D2-SHUTDOWN-003: process killed with SIGTERM during shutdown flush —
  assert partial flush leaves the spool in a replayable state (no
  truncated/corrupt file per §3), not merely "flush attempted."
- D2-SHUTDOWN-004: process killed with SIGKILL (no graceful shutdown
  possible at all) — assert next startup's replay recovers whatever was
  durably spooled before the kill, with no assumption of a clean shutdown
  marker.
- D2-SHUTDOWN-005: repeated reload cycles in one process lifetime (stress,
  e.g. 20x `/reload`) — assert no owner-token/epoch leak, no growing set of
  abandoned consumers, and no daemon restart storm (`ensureDaemon()` must
  still coalesce to the existing live daemon each time per §1).

## 14. Moshi coexistence

- D2-MOSHI-001: Moshi Hook installed and running alongside this daemon —
  verify no port collision on Moshi's `127.0.0.1:24543` gateway and no
  attempt to share/reuse Moshi's Unix socket.
- D2-MOSHI-002: per `OBS-D-004`, when Moshi is configured, verify the child
  protected-path policy (§9) also denies Moshi's own local socket/session
  directories to children of _this_ orchestration's agents, using the same
  deny mechanism (not a separate, unverified allowlist).
- D2-MOSHI-003: verify no rich observability payload captured by this
  daemon is ever forwarded into Moshi's bounded cloud-summary channel (no
  accidental cross-wiring/env var/socket write from this codebase into
  Moshi's ingestion path).
- D2-MOSHI-004: verify this daemon does not read, parse, or depend on
  Moshi's private per-session JSON projection files for any correctness-
  critical behavior (optional future importer is out of D2 scope entirely;
  D2 must not quietly start doing this).
- D2-MOSHI-005: both tools running simultaneously under real Pi hooks —
  assert neither tool's hook handler exceptions affect the other (hook
  handler isolation), and that installing/uninstalling Moshi does not change
  this daemon's autostart/lock behavior.

## 15. Metrics / gap events

- D2-METRICS-001: extend D1's counters (`accepted, duplicate, conflict,
rejected, batches, projectIdMismatch, truncations, rejectedByReason,
redactionByClass`) with whatever new D2 counters are introduced (spool
  writes/replays, policy downgrades, child-path denials, coalescing drops) —
  assert each new counter is bounded/sanitized the same way as existing ones
  (`nonnegativeInteger`, key-name regex allowlist) so a hostile `kind`/`rule`
  string cannot inject an unbounded-cardinality metrics key.
- D2-METRICS-002 (gap detection — new for D2/E): simulate a genuine data
  loss window (spool cap eviction, or a crash between spool-write and
  replay) and assert the daemon/producer surfaces a detectable "gap" signal
  (e.g. a discontinuity in `producer.seq` per producer, or an explicit gap
  counter/event) rather than silently presenting a continuous-looking
  timeline; this is required for Task E's "gap status visible... without
  turning the TUI into a second query engine."
- D2-METRICS-003: gap detection must not itself leak content — a gap
  event/counter records counts and boundary sequence numbers only, never
  the content of the lost events.
- D2-METRICS-004: metrics file corruption/tampering (hand-edited
  `daemon-metrics.json` with out-of-range or negative values) — assert
  `loadMetrics`-equivalent D2 loader still coerces to safe defaults rather
  than propagating attacker-controlled values into displayed status.
- D2-METRICS-005: metrics under sustained high load (thousands of
  events/sec for several minutes) — assert counters remain monotonic and
  consistent with independently-counted spool/DB row counts (no drift from
  double-counting or missed increments under concurrency).

## 16. No D3-D5 leakage

Static/negative tests, mirroring the existing `workflows/no-legacy-runner.test.ts`
pattern of proving absence, not just presence:

- D2-SCOPE-001: no read/query HTTP route beyond `/healthz` and
  `POST /v1/ingest` exists after D2 (no `/v1/runs`, `/v1/events`, `/v1/agents`,
  or any GET data route) — D3 introduces those.
- D2-SCOPE-002: no static file serving / no bundled UI assets / no HTML
  response from the daemon.
- D2-SCOPE-003: no artifact reconciliation, no redacted run/result/transcript
  artifact writer, no retention/purge/export code path exists yet (D4 scope);
  existing workflow artifacts (`workflows/artifacts.ts`) remain the only
  artifact writer, unmodified in behavior by D2.
- D2-SCOPE-004: no change-summary/diff-attribution feature exists (D5 scope);
  D2 does not add any "shared/unattributed" labeling machinery prematurely.
- D2-SCOPE-005: no new application table beyond the existing exact three
  (`events`, `runs`, `agents`) — D2 adds producer/spool/hook wiring, not
  schema changes; assert `assertGoldenSchema`-style drift detection still
  passes unmodified.
- D2-SCOPE-006: no TUI/dashboard code path added or changed as part of D2
  (Task E is separate); `/subagents` and `/workflows` dashboards' current
  behavior is provably unchanged by D2 (snapshot/regression diff).
- D2-SCOPE-007: no read-token usage anywhere in D2 code (read token is
  minted/reserved by D1 for D3 only) — grep/static-analysis check that no D2
  producer or daemon code path consumes `readToken` for anything.
- D2-SCOPE-008: no remote/non-loopback network surface added (still
  `127.0.0.1` ephemeral only) and no PostgreSQL/external-blob dependency
  introduced.

## Cross-cutting non-functional checks

- Every new adversarial test above should follow the existing repo pattern:
  deterministic temp companion-home per test (`tempAgentDir` helper),
  subprocess-based daemon lifecycle where real process kill/restart
  semantics matter, and assertion against machine-readable exit codes
  (`EXIT.*`) rather than string-matching log output.
- Full gate re-run required before acceptance: `npm test`,
  `npm run format:check`, `npm run smoke`,
  `PI_OFFLINE=1 pi --list-models`, plus the D2-specific redaction leak scan
  extended with the corpus in §6 across spool + DB + WAL/SHM + logs +
  metrics + HTTP responses.
- Any test that cannot be made to pass for a specific backend (Claude or
  Codex sandbox variance in §9/§10) must result in rich capture being
  disabled for that backend, per the architecture doc's own acceptance gate
  — not a skipped/xfail test with capture left enabled.
