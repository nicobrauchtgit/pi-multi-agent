# Implementation Task Loop

_Status: design direction accepted; implementation not started_
_Last updated: 2026-08-31_

This is a **coded parent-side orchestration feature** for implementation work. It
is separate from automatic subagent handoff.

Goal: run implementation and review in a loop until both required gates are true
for the same code checkpoint.

```text
acceptance_met && no_changes_requested
```

---

## 1. Scope

### In scope

- A coded controller under the subagents extension.
- A user-facing slash command, e.g. `/implement <task prompt>`.
- Markdown prompt files for implementation/review behavior.
- Durable task identity independent of agent IDs.
- Implementation agents run the relevant checks/tests.
- Review agents approve or request required changes.

### Out of scope

- Automatic context handoff internals.
- Child-created subagents or workflows.
- Separate default test agent.
- Environment-variable mutation for per-task state.
- Hard worktree isolation in v1.

---

## 2. Module boundary

Add a dedicated module:

```text
extensions/subagents/src/task-loop/
  controller.ts   implementation/review loop
  state.ts        task state
  schema.ts       implementation/review result schemas
  prompts.ts      markdown prompt loading
  checks.ts       acceptance check evidence
  command.ts      /implement command registration
```

Prompt files:

```text
extensions/subagents/prompts/task-loop/
  implementation.prompt.md
  review.prompt.md
  rework.prompt.md
```

The controller renders prompt files with explicit bounded data. Prompt behavior
should be adjustable by editing markdown, not TypeScript strings.

---

## 3. User command

Expose a live-session command:

```text
/implement <task prompt>
```

The command should:

1. create a task from the user prompt;
2. require or derive measurable acceptance checks;
3. spawn an implementation subagent;
4. collect implementation result and check evidence;
5. spawn a review subagent;
6. feed required review issues into the next implementation step;
7. exit only when both gates are true.

The command is parent/user-facing only. Child subagents cannot invoke it.

---

## 4. The two gates

| Gate                   | Set by              | Requirement                             |
| ---------------------- | ------------------- | --------------------------------------- |
| `acceptance_met`       | implementation step | Required measurable code checks passed. |
| `no_changes_requested` | review step         | Reviewer returned no required changes.  |

Rules:

- Implementation can set only `acceptance_met`.
- Review can set only `no_changes_requested`.
- Both gates must refer to the same checkpoint.
- Any code change after review invalidates `no_changes_requested`.
- Rework is just another implementation step with review feedback included.

---

## 5. Acceptance checks

Acceptance must be measurable in code.

Typical check:

```text
id: focused-tests
command: npm test -- ...
expected exit: 0
```

Implementation agents must run required checks before claiming acceptance. The
controller should fail closed:

- missing check evidence => `acceptance_met = false`;
- failed check => `acceptance_met = false`;
- malformed implementation result => step failed/blocker visible to parent.

The controller may verify checks from tool details or rerun checks itself. That
controller verification is not a separate test agent.

---

## 6. Review

Review receives:

- task prompt;
- acceptance checks and evidence;
- checkpoint;
- changed files;
- implementation summary;
- known risks.

Review returns:

```text
changes requested: yes/no
required issues: list
optional suggestions: list
summary
```

Only required issues keep the loop open. Optional suggestions do not.

Review should be read-only where possible. For Pi this can use read-only tool
sets. Also use pre/post dirty checks; reviewer mutation is a review failure.

---

## 7. Minimal state

```text
TaskLoop
  taskId
  prompt
  acceptanceChecks
  status: implementing | reviewing | done | failed
  checkpoint
  acceptanceMet
  noChangesRequested
  attempts[]
  latestReviewIssues[]
```

Attempts reference logical subagents, not concrete backend sessions:

```text
Attempt
  step: implementation | review
  logicalSubagentId
  result
  changedFiles
  checksRun
```

If automatic handoff is enabled, one logical subagent may contain multiple Pi SDK
session segments, but the task loop does not care.

---

## 8. Parallelism and clashes

Parallelism is task-level, not agent-level.

Rules:

- each task declares expected write scope;
- overlapping implementation/rework scopes do not run concurrently;
- review should not write;
- if implementation discovers it needs out-of-scope edits, it reports a
  coordination issue;
- locks follow the task/step, not the current agent ID.

Shared worktree coordination is not hard isolation. Hard isolation can come
later with worktrees or patch queues.

---

## 9. Relationship to automatic handoff

The task-loop controller uses logical subagents.

```text
task implementation step
  └─ logical subagent
       ├─ segment 1
       ├─ segment 2 after cutoff
       └─ final step result
```

Automatic handoff is invisible to task-loop gate logic except as progress and
handoff summaries.

---

## 10. Relationship to auto-smart-lab

Keep the useful pattern:

```text
orchestrator owns loop
solver implements and validates
evaluator approves or rejects
feedback feeds next solver run
```

Generalize it here:

```text
task-loop controller owns loop
implementation edits and runs acceptance checks
review approves or requests changes
required issues feed next implementation step
```

Do not copy:

- process-wide `process.env` mutation;
- sentinel parsing as the primary contract;
- fallback approval when review output is malformed.

Prefer structured outputs and fail closed.

---

## 11. Acceptance criteria

This feature is designed correctly when:

- `/implement <task>` starts a coded parent-owned loop;
- task state is not tied to one `agentId`;
- implementation can prove `acceptance_met` with measurable checks;
- review can set `no_changes_requested` or return required issues;
- both gates must match the same checkpoint;
- implementation/rework agents own their tests;
- prompts are markdown files;
- no per-task state is passed through `process.env`;
- child recursive orchestration remains forbidden.
