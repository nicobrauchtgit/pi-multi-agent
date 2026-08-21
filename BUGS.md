# Bug tracker

Confirmed issues found during implementation and review are recorded here. Blocking defects are fixed in the current task; valid deferred work remains listed until resolved.

## Open bugs

None.

## Deferred implementation work

- **TASK-C-001 — Two workflow agent paths:** Workflow `agent()` still uses the Pi-only runner instead of `SubagentManager`. Task C1 must move workflow-owned agents to the manager and fully remove the legacy execution path before observability database work begins; downstream support for two event vocabularies is explicitly out of scope.
- **TASK-C-002 — Workflow result retrieval versus manager pruning:** C1's wait-then-get bridge must pin or atomically consume a workflow settlement so `MAX_TRACKED` pruning cannot remove it between `waitFor()` and `get()`. Explicit workflow return values must remain retrievable under high churn.
- **TASK-C-003 — Workflow roles must not leak into standalone persistence:** Workflow-owned agents must remain role-less, or role persistence and role-list/model-facing surfaces must be explicitly gated by origin. Workflow metadata must never create resumable standalone role records accidentally.
- **TASK-C-004 — Workflow metadata bounds:** `workflowRunId`, phase, label, index, and future workflow-origin metadata must be validated and byte-bounded before snapshot/artifact persistence or TUI rendering; the groundwork fields are not yet a persistence contract.
- **TASK-D-001 — Durable structured-result artifacts:** Task B exposes validated structured results through live snapshots and tool/result delivery. Persisting redacted results in the shared run artifact store and linking role records to the latest artifact remains part of Task D4.
- **OBS-D-001 — Existing workflow artifacts are not secret-redacted:** `extensions/workflows/artifacts.ts` bounds transcripts/results, and `serialization.ts` writes them atomically, but neither applies secret redaction. Observability reconciliation must re-redact imports, and new shared artifacts must use the common scrubber; it must not create another unredacted copy.
- **OBS-D-002 — Child path isolation is not yet sufficient for observability state:** `CHILD_EXCLUDED_TOOL_NAMES` removes orchestration tools, while normal file and shell tools remain available. Before rich capture is enabled, every backend needs an enforced protected-path boundary for daemon tokens, DB/WAL/SHM, spool, config, existing workflow artifacts, and new artifacts, plus `0700`/`0600` ownership/mode verification.
- **OBS-D-003 — Shared-worktree changes cannot be attributed exactly:** Standalone and workflow children normally share cwd, and current manager/workflow events do not capture an isolated before/after patch. Any future v1 change summary must remain `shared/unattributed`; exact attribution is deferred until isolation or another non-racy ownership boundary exists.
- **OBS-D-004 — Moshi interoperability and protected paths:** A future optional Moshi projection importer must remain secondary/lossy artifact provenance and must not depend on Moshi's private socket protocol or state schema. When Moshi is configured, the canonical child protected-path policy must cover its Unix socket and local state/session directories, and no rich observability payload may be forwarded into Moshi's bounded cloud-summary channel.
- **TASK-E-001 — Structured status in supervisor UI:** The `/subagents` dashboard does not yet show a dedicated structured-output success/failure badge. This remains optional Task E UX work; schema failures are already visible through normal error text and tool details.

## Planning/tooling lessons

- **TOOLING-001 — Large inline workflow handoffs can exceed the agent-request limit:** Workflow `wf_275662319c63` completed seven inventory/architecture/review agents, then failed in the Document phase with `Workflow sandbox sent an invalid agent request` after the script concatenated the full architecture output and all review data into one author prompt. For large research workflows, persist each handoff as a bounded artifact and pass paths plus a compact index/decision summary to the author; do not inline every long response into the next request.

## Resolved during Task B

- **B-001 — Quadratic JSON extraction:** Replaced repeated balanced-candidate rescans with a bounded single-pass scanner and a 64 KiB source limit.
- **B-002 — Schema regex ReDoS:** Reject `pattern`, `patternProperties`, and `format` before synchronous validation.
- **B-003 — Accept-any/unsupported schemas:** Added semantic validation for a conservative object-root JSON Schema subset and Codex strict-mode preflight.
- **B-004 — Stale per-turn structured state:** Clear structured state synchronously before dispatch and reset Pi capture state at native `agent_start`.
- **B-005 — Active-role schema mismatch:** Compare resume overrides with the live session contract and surface invalid persisted contracts instead of silently dropping them.
- **B-006 — Claude schema prompt injection:** Escape `<` in embedded schema JSON so descriptions cannot close the schema delimiter.
- **B-007 — Unbounded/invalid UTF-8 result details:** Bound structured result content and details with UTF-8-safe truncation.
- **B-008 — Missing maintained checks:** Added root TypeScript coverage and included previously omitted shared/workflow tests in `npm test`.
