# Bug tracker

Confirmed issues found during implementation and review are recorded here. Blocking defects are fixed in the current task; valid deferred work remains listed until resolved.

## Open bugs

None.

## Deferred implementation work

- **TASK-D-001 — Durable structured-result artifacts:** Task B exposes validated structured results through live snapshots and tool/result delivery. Persisting them in the shared run artifact store and linking role records to the latest artifact remains part of Task D.
- **TASK-E-001 — Structured status in supervisor UI:** The `/subagents` dashboard does not yet show a dedicated structured-output success/failure badge. This remains optional Task E UX work; schema failures are already visible through normal error text and tool details.

## Resolved during Task B

- **B-001 — Quadratic JSON extraction:** Replaced repeated balanced-candidate rescans with a bounded single-pass scanner and a 64 KiB source limit.
- **B-002 — Schema regex ReDoS:** Reject `pattern`, `patternProperties`, and `format` before synchronous validation.
- **B-003 — Accept-any/unsupported schemas:** Added semantic validation for a conservative object-root JSON Schema subset and Codex strict-mode preflight.
- **B-004 — Stale per-turn structured state:** Clear structured state synchronously before dispatch and reset Pi capture state at native `agent_start`.
- **B-005 — Active-role schema mismatch:** Compare resume overrides with the live session contract and surface invalid persisted contracts instead of silently dropping them.
- **B-006 — Claude schema prompt injection:** Escape `<` in embedded schema JSON so descriptions cannot close the schema delimiter.
- **B-007 — Unbounded/invalid UTF-8 result details:** Bound structured result content and details with UTF-8-safe truncation.
- **B-008 — Missing maintained checks:** Added root TypeScript coverage and included previously omitted shared/workflow tests in `npm test`.
