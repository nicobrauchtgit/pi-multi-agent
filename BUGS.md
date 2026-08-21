# Bug tracker

Confirmed issues found during implementation and review are recorded here. Blocking defects are fixed in the current task; valid deferred work remains listed until resolved.

## Open bugs

- **C1-REG-001 — Workflow transcript artifacts now contain manager UI previews, not the legacy runner's fuller tool payloads:** Manager-backed workflow transcripts intentionally project normalized `argsPreview`/`outputPreview` fields. For Pi tools this can reduce arguments to roughly 4 KiB and results to the first non-empty line, whereas the removed runner retained larger tool arguments and full result text. Restoring rich recoverable payloads safely belongs with D2 capture and D4 redacted artifacts; current `transcripts.json` must not be described as a full-fidelity transcript.
- **C1-REG-002 — Oversized explicit workflow results degrade to a whole-result truncation stub:** Core `workflow.json` state now degrades per field and preserves run/agent identity, but an explicit script return above the 1 MiB `result.json` bound is still replaced by the serialization truncation object. D4 should store redacted result artifacts with per-field or content-aware degradation while preserving a stable artifact envelope.

## Deferred implementation work

- **TASK-D-001 — Durable structured-result artifacts:** Task B exposes validated structured results through live snapshots and tool/result delivery. Persisting redacted results in the shared run artifact store and linking role records to the latest artifact remains part of Task D4.
- **OBS-D-001 — Existing workflow artifacts are not secret-redacted:** `extensions/workflows/artifacts.ts` bounds transcripts/results, and `serialization.ts` writes them atomically, but neither applies secret redaction. Observability reconciliation must re-redact imports, and new shared artifacts must use the common scrubber; it must not create another unredacted copy.
- **OBS-D-002 — Child path isolation is not yet sufficient for observability state:** `CHILD_EXCLUDED_TOOL_NAMES` removes orchestration tools, while normal file and shell tools remain available. Before rich capture is enabled, every backend needs an enforced protected-path boundary for daemon tokens, DB/WAL/SHM, spool, config, existing workflow artifacts, and new artifacts, plus `0700`/`0600` ownership/mode verification.
- **OBS-D-003 — Shared-worktree changes cannot be attributed exactly:** Standalone and workflow children normally share cwd, and current manager/workflow events do not capture an isolated before/after patch. Any future v1 change summary must remain `shared/unattributed`; exact attribution is deferred until isolation or another non-racy ownership boundary exists.
- **OBS-D-004 — Moshi interoperability and protected paths:** A future optional Moshi projection importer must remain secondary/lossy artifact provenance and must not depend on Moshi's private socket protocol or state schema. When Moshi is configured, the canonical child protected-path policy must cover its Unix socket and local state/session directories, and no rich observability payload may be forwarded into Moshi's bounded cloud-summary channel.
- **OBS-D-005 — Producer-side aggregate event budgets remain for D2:** D1 now enforces daemon-side individual/aggregate content budgets with deterministic UTF-8-safe truncation/omission and a complete second redaction scan. C0's test-only recording sink still rejects an oversized generic event as a whole, and no production producer is connected yet. Keep this open until D2 applies the same shared normalization policy before queue/spool disk writes; D1 alone must not be described as closing the producer-side leak boundary.
- **OBS-D-006 — Independent daemon project policy remains a D2 gate:** The disconnected D1 daemon safely enforces the event's bounded `capture.contentMode`, but it has no protected longest-root project configuration of its own. D2 must make producer policy advisory only: independently reject disabled-project events, force configured metadata-only capture, and never let a producer opt a project into richer capture than daemon policy permits.
- **TASK-E-001 — Structured status in supervisor UI:** The `/subagents` dashboard does not yet show a dedicated structured-output success/failure badge. This remains optional Task E UX work; schema failures are already visible through normal error text and tool details.

## Planning/tooling lessons

- **TOOLING-001 — Large inline workflow handoffs can exceed the agent-request limit:** Workflow `wf_275662319c63` completed seven inventory/architecture/review agents, then failed in the Document phase with `Workflow sandbox sent an invalid agent request` after the script concatenated the full architecture output and all review data into one author prompt. For large research workflows, persist each handoff as a bounded artifact and pass paths plus a compact index/decision summary to the author; do not inline every long response into the next request.

## Resolved during Task D1

- **D1-001 — Bare-Node module/runtime boundary:** Added a no-build `.mjs` companion that probes Node 22.5+ and constructible `node:sqlite`, performs at most one guarded flag re-exec, and has no alternate SQLite or extension runtime dependency. Pi extensions do not import the companion; the production sink remains no-op.
- **D1-002 — Single shared security scrubber:** Added one dependency-free `extensions/shared/redaction.mjs` implementation used by the daemon and importable by future Pi producer code. Known and unknown payloads use recursive redact → UTF-8-safe bound/omit → complete re-scan; tests reject a copied companion implementation and scan DB/sidecars/logs/counters/responses for seeded plaintext.
- **D1-003 — Atomic storage/projection ownership:** Added protected home/lock/state/token ownership, one WAL writer, exact three-table migration v1, complete normalized-stored-event fingerprint idempotency/conflict handling, daemon receive sequence, pure reducers, and offline rebuild. Injected insert/projection faults and SIGKILL WAL recovery leave neither orphan events nor orphan projections.
- **D1-004 — D1 network surface stayed narrow:** The daemon binds only an ephemeral `127.0.0.1` port and exposes minimal `/healthz` plus exact-Host ingest-token `POST /v1/ingest`. Wrong token/scope/Host/origin/content type/body/version fail without persistence; no read data route, static UI, CORS grant, payload log, or model-visible surface exists.
- **D1-005 — D1 review hardening:** Exact marker idempotency and secret-field subtree suppression close marker-bearing redaction leaks; stale reclaim revalidates lock identity/token and newly created ownership; producer truncation provenance survives independently from daemon truncation; full schema SQL, lone-surrogate, complete-fingerprint, numeric SQLite-error, health-idle/Host, marker-density, projection-size, atomic-temp cleanup, and distinct runtime-exit regressions are covered.

D1 leaves `C1-REG-001`, `C1-REG-002`, `TASK-D-001`, `OBS-D-001` through `OBS-D-006` open for their documented D2/D4/E phases. No D1 implementation defect is knowingly deferred as part of the accepted D1 scope.

## Resolved during Task C1

- **TASK-C-001 — Two workflow agent paths:** Resolved by routing DSL `agent()` exclusively through `SubagentManager.runWorkflowAgent()` for Pi, Claude, and Codex, deleting `workflows/runner.ts` and its tests, and adding a static non-reachability test. No fallback flag exists.
- **TASK-C-002 — Workflow result retrieval versus manager pruning:** Resolved with a fused manager reservation/spawn/collect operation. The durable reservation creates a collection pin before backend work, then returns a frozen bounded settlement copy before releasing the pin; high-fanout tests exceed `MAX_TRACKED` without losing results.
- **TASK-C-003 — Workflow roles must not leak into standalone persistence:** Resolved by rejecting role, role-lease, resume, and send operations for workflow origin and origin-gating settlement/metadata persistence plus the pure role-upsert adapter. Model-facing standalone tools continue to filter non-model origins.
- **TASK-C-004 — Workflow metadata bounds:** Resolved by exact run-ID/index validation and UTF-8 byte bounds for phase/label in the manager reservation, with defensive artifact/dashboard normalization tests.
- **TASK-C-005 — Workflow sink ownership is test-only until C1:** Resolved by removing the second workflow factory argument and consuming the subagents-owned versioned process service/sink. Duplicate-module, load-order, child-load, epoch, replacement, and shutdown behavior is tested.
- **TASK-C-006 — Child orchestration filter was reset during resource reload:** Resolved by filtering the scoped SettingsManager getters used by PackageManager, running resource factories inside the child AsyncLocalStorage scope, and filtering the final loaded extension set. An end-to-end resource-load test uses the real subagents/workflows paths and verifies they and their tools are absent.
- **TASK-C-007 — Per-agent structured mirrors could replace workflow.json with a truncation stub:** Resolved by keeping structured values in the explicit `agent()` return only, explicitly bounding workflow summary fields, and refusing wholesale summary replacement. A 20-agent × 60 KiB regression fixture preserves run identity, status, and every agent record.

Evidence: static removal guards, hermetic service/manager/bridge/cancellation/artifact/dashboard suites, full repository gates, an opt-in live structured Pi/Claude/Codex workflow matrix, and a live cancellation/artifact test all pass. No Task D daemon, SQLite, network/spool, redaction, web, or diff work was included.

## Resolved during Task B

- **B-001 — Quadratic JSON extraction:** Replaced repeated balanced-candidate rescans with a bounded single-pass scanner and a 64 KiB source limit.
- **B-002 — Schema regex ReDoS:** Reject `pattern`, `patternProperties`, and `format` before synchronous validation.
- **B-003 — Accept-any/unsupported schemas:** Added semantic validation for a conservative object-root JSON Schema subset and Codex strict-mode preflight.
- **B-004 — Stale per-turn structured state:** Clear structured state synchronously before dispatch and reset Pi capture state at native `agent_start`.
- **B-005 — Active-role schema mismatch:** Compare resume overrides with the live session contract and surface invalid persisted contracts instead of silently dropping them.
- **B-006 — Claude schema prompt injection:** Escape `<` in embedded schema JSON so descriptions cannot close the schema delimiter.
- **B-007 — Unbounded/invalid UTF-8 result details:** Bound structured result content and details with UTF-8-safe truncation.
- **B-008 — Missing maintained checks:** Added root TypeScript coverage and included previously omitted shared/workflow tests in `npm test`.
