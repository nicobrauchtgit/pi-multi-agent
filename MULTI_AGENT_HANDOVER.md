# Multi-Agent Setup — Handover

_Last updated: 2026-08-21_

This is the current handover for the Pi multi-agent repository under:

```text
~/Projects/pi-multi-agent/extensions/{subagents,workflows,shared}
```

Pi loads the `subagents` and `workflows` entry-point directories through absolute paths in `~/.pi/agent/settings.json`; `shared` is imported by both. This document replaces the older MVP/handoff notes. Read this document before continuing work on the subagents/workflows stack.

---

## 1. Intent

We are building a dynamic multi-agent system for Pi with:

- real multi-harness subagents: **Pi**, **Claude Code**, **Codex**;
- workflow scripts for model-authored fan-out/fan-in orchestration;
- explicit handover through workflow return values and structured outputs;
- Hunk-backed shared blackboard for coordination;
- live supervision and same-session follow-up;
- persistent role records, then backend-native cross-session resume;
- better result/artifact integration.

Design preference from Nicolas:

- **Do not add a model-visible workflow budget API.** Internal safety caps are fine, but the model should not be asked to budget subagent work. Subagents should receive clear tasks and do their best.
- **Do not add a direct agent-to-agent messaging bus for now.** Use explicit workflow variables/results for source-of-truth handover; use Hunk as a coordination side-channel.
- **Keep errors as the signal.** Do not invent a separate blocked/input-required state unless truly necessary. Parent/model should inspect error text and decide retry/fix/escalate.

---

## 2. Current live surface

### Commands

```text
/subagents
/workflows
/btw
```

### Tools

Standalone subagents:

```text
subagent_spawn
subagent_wait
subagent_cancel
subagent_check
subagent_list
subagent_followup
subagent_resume
subagent_roles
subagent_forget
```

Workflow orchestration:

```text
workflow
```

### Important restart note

Extension edits under `~/Projects/pi-multi-agent/extensions/...` take effect on the next Pi restart or `/reload`. Smoke-load commands below can validate extension loading without needing an interactive restart.

---

## 3. Architecture map

```text
extensions/subagents/
  index.ts                         tool/command registration, parent API boundary
  src/domain.ts                    BackendName, SpawnTask, SubagentEvent, SubagentSnapshot
  src/backend.ts                   SubagentBackend/SubagentSession interfaces
  src/manager.ts                   SubagentManager, live registry, wait/cancel/send, snapshots
  src/backends/pi.ts               in-process Pi SDK AgentSession backend
  src/backends/claude.ts           Claude Agent SDK streaming-input backend
  src/backends/codex.ts            codex app-server JSON-RPC backend
  src/roles.ts                     persistent role registry under ~/.pi/agent/multi-agent/roles
  src/prompt.ts                    model-facing strings for subagent tools
  src/result-delivery.ts           deferred parent result delivery
  src/structured-output.ts         final-JSON extraction and schema validation
  src/ui/takeover.ts               /subagents dashboard + takeover UI
  src/ui/transcript.ts             transcript rendering

extensions/workflows/
  index.ts                         workflow tool, /workflows command, progress/UI wiring
  sandbox.ts                       permission-mode child process IPC host
  sandbox-child.cjs                VM DSL bootstrap inside restricted child
  controller.ts                    run-wide agent scheduling/cancellation cap
  runner.ts                        workflow child Pi AgentSession runner
  model.ts                         WorkflowDetails + formatting helpers
  prompt.ts                        model-facing workflow DSL guidance
  dashboard.ts                     /workflows dashboard
  artifacts.ts                     workflow.json/result.json/transcripts.json persistence
  meta.ts                          static metadata parser
  serialization.ts                 bounded JSON/atomic writes

extensions/shared/
  child-session.ts                 trust-aware child resources, tool denylist, shutdown
  json-schema.ts                   bounded JSON Schema guard + TypeBox adapter
  structured-output.ts             terminating Pi structured_output tool
  tool-call-timeout.ts             bounded child tool execution guard
  hunk-blackboard.ts               auto-provisioned Hunk shared blackboard
  activity-status.ts
  context-utilization.ts
  dashboard-state.ts
```

### Two spawn paths still exist

This is the most important architectural caveat:

```text
Standalone subagents
  -> SubagentManager
  -> pi / claude / codex backends
  -> rich live events, steering, follow-up, roles

Workflow agent()
  -> workflows/runner.ts
  -> in-process Pi child sessions only
  -> structured output, artifacts, workflow progress
```

Task C groundwork is implemented: manager snapshots can carry workflow ownership metadata, workflow-origin settlements suppress standalone parent delivery, and manager wait/get seams can support a future bridge. This does **not** unify execution: workflow `agent()` still uses the legacy Pi-only runner, and both C0 observability contracts and C1 execution unification remain not started.

---

## 4. Current capabilities

### 4.1 Standalone subagents

`subagent_spawn` creates autonomous background children. Each child:

- has a fresh context window;
- cannot see the parent conversation;
- cannot ask the user;
- cannot recursively call subagent/workflow tools;
- receives normal harness tools/config for its backend;
- gets Hunk blackboard instructions when available.

Supported harnesses:

```text
pi      in-process Pi SDK session
claude  Claude Code Agent SDK
codex   codex app-server JSON-RPC
```

The manager tracks normalized events:

```text
RunStarted / RunSettled
UserMessage
AssistantDelta / AssistantMessage
ToolStart / ToolUpdate / ToolEnd
QueueChanged
UsageChanged
MetaChanged
BackendError
```

`SubagentManager.send(id, text)` is the continuation primitive:

- running agent: backend-native steering/queueing;
- settled/idle agent: starts a fresh turn in the same native session.

This is now exposed to the model through:

```text
subagent_followup({ id, prompt })
```

`subagent_spawn` also accepts an optional bounded, object-root JSON `schema`.
The supported subset rejects unknown/invalid keywords and all regex-bearing
`pattern`/`format` forms before they can enter synchronous validation. The
contract applies independently to every turn in the native session:

- Pi receives a strict schema-validated, terminating `structured_output` tool;
- Codex 0.147+ receives native strict `turn/start.outputSchema` on every turn;
  version and strict-schema compatibility are checked before work starts, and
  the returned final JSON is validated locally;
- Claude keeps the same `claude_code` base preset with or without a schema,
  receives an injection-safe persistent final-JSON append, and has its bounded
  final text extracted and validated locally.

Snapshots and tool details expose `structured` and `schemaError`. Missing or
invalid required structured output settles the run as `error`, while partial
assistant text remains available for diagnosis. Starting a follow-up clears the
prior turn's structured state before the new result arrives.

### 4.2 Persistent roles and backend-native resume — done

`subagent_spawn` now accepts:

```ts
role?: string
```

Role names normalize spaces to `-`, lowercase, and allow letters/digits/`.`/`_`/`-`.

Role records are stored one-file-per-role under:

```text
~/.pi/agent/multi-agent/roles/<base64url-role>.json
```

Record shape:

```ts
interface PersistentSubagentRecord {
  version: 1;
  role: string;
  title: string;
  backend: "pi" | "claude" | "codex";
  cwd: string;
  model?: string;
  modelLabel?: string;
  reasoningEffort?:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  schema?: JsonSchema;
  sessionFilePath?: string;
  nativeSessionId?: string;
  lastSubagentId?: string;
  status: "idle" | "running" | "done" | "error" | "missing";
  createdAt: number;
  updatedAt: number;
  parentPiSessionId?: string;
}
```

Current role tools:

```text
subagent_roles    list role records
subagent_forget   remove only the registry record; do not delete native history
```

Backend-native cross-session resume is implemented through:

```text
subagent_resume({ role, prompt, working_dir?, model?, reasoning_effort?, schema? })
```

Behavior:

- a role already tracked in the current manager routes to that native session through `manager.send()`;
- after a Pi restart, the role reopens under a fresh current-session `sa-N`;
- Pi resumes with `SessionManager.open(sessionFilePath, undefined, cwd)`;
- Claude resumes with the Agent SDK's `options.resume = nativeSessionId`;
- Codex resumes with app-server `thread/resume`;
- trust is recalculated and the Hunk blackboard is refreshed on every reopen;
- named roles hold a machine-local process-safe lock for the manager entry lifetime, with dead-PID lock recovery.

### 4.3 Workflow DSL — DSL-first uplift done

Workflow scripts now expose:

```js
phase(title)
log(message)
agent(prompt, opts)
parallel(thunks, opts?)
pipeline(items, ...stages)
args
cwd
process.cwd()
```

No `budget` global exists by design.

`meta.phases` is optional documentation. Runtime progress is driven by `phase(title)`.

`pipeline(items, ...stages)` semantics:

- validates `items` as an array;
- validates each stage is a function;
- fans out items concurrently, max 4 active items;
- runs stages sequentially per item;
- each stage receives `(previous, original, index)`;
- returns results in item order.

Use `pipeline` for explicit per-item handover chains, e.g. summarize → critique → synthesize.

`log(message)` sends bounded workflow log lines. Logs are persisted and displayed in workflow UI/results.

### 4.4 Workflow artifacts

Workflow run artifacts are saved under:

```text
~/.pi/agent/workflows/<runId>/
  script.js
  args.json              when args were supplied
  workflow.json          compact run state
  result.json            when result exists
  transcripts.json       bounded child transcripts
```

Workflows have no resume yet. Failed runs are rerun/repaired manually for now.

### 4.5 Hunk blackboard

`shared/hunk-blackboard.ts` auto-provisions a Hunk session when possible:

- resolves git root;
- checks for live `hunk session`;
- if none, starts `hunk diff` headlessly via PTY;
- injects read/write instructions into subagent/workflow-child prompts.

Agent usage:

```bash
hunk session comment list --repo <root> --json
hunk session review --repo <root> --include-notes --json
hunk session comment add --repo <root> --file <path> --new-line <line> --author <role> --summary <text> --rationale <text>
```

Constraints:

- requires a git repo and a diff/lines to anchor comments;
- session is ephemeral and process-scoped;
- use as coordination side-channel, not source-of-truth handover.

---

## 5. Error-handling policy

Errors are the only signal. The parent/model must inspect error text and decide.

### Retry once when error is clearly transient

Examples:

```text
DAILY_CAP_EXCEEDED
rate limit
quota exceeded
timeout
provider request may be stalled
network error / ECONNRESET
backend temporarily unavailable
model overloaded
```

If the parent model can continue after such an error, assume the subagent may also be able to continue. Try exactly one retry/continuation before abandoning it.

For current-session subagents:

```text
subagent_followup({ id, prompt: 'Continue the original task from where you left off. ...' })
```

Do **not** loop retries. If it fails again, report and proceed manually or switch harness.

### Do not blindly retry non-transient errors

Examples:

```text
invalid model
unknown subagent id
invalid workflow script
schema validation failed
permission denied due to sandbox policy
missing binary/auth that has not been fixed
file/path not found due to bad prompt
```

Fix the cause, ask the user if needed, or spawn a corrected replacement.

### Ambiguous errors

For generic failures, inspect:

```text
subagent_check
/subagents transcript
/workflows details
artifacts/transcripts
```

Then decide whether one retry is justified.

---

## 6. Next tasks, in recommended order

### Task A — Backend-native `subagent_resume` — completed 2026-08-19

Implemented and verified:

- current-session roles route through `manager.send()`;
- inactive roles reopen native Pi, Claude, or Codex history under a fresh `sa-N`;
- named spawns/resumes hold process-safe role locks until their manager entry is disposed;
- missing cwd/session locators produce clear errors and mark the role `missing`;
- trust and Hunk blackboard state are recalculated on resume;
- focused manager/lock tests pass;
- live restart tests recalled unique prior-turn markers for Pi, Claude, and Codex in fresh Pi processes.

Remaining limitation: this resumes persisted history after restart; it does not reconnect to a turn that was still running when Pi exited.

---

### Task B — Structured outputs for standalone subagents — completed 2026-08-20

Implemented and verified:

- `subagent_spawn` accepts a bounded, semantically checked, object-root JSON
  `schema`; invalid/unknown keywords, regex-bearing validation, non-JSON data,
  cycles, unsafe keys, excessive depth/nodes, and oversized schemas fail before
  manager reservation;
- Pi injects the shared strict schema-validated terminating `structured_output`
  tool and resets its capture sentinel at every native `agent_start`, including
  retry/continue paths;
- Codex sends native `turn/start.outputSchema` on every initial and follow-up
  turn, rejects incompatible strict schemas up front, requires app-server
  0.147.0+, then parses and validates the final assistant value defensively;
- Claude keeps one base `claude_code` preset, adds an injection-safe persistent
  structured-output append only when needed, then uses 64 KiB bounded,
  single-pass raw/fenced/balanced JSON extraction and local validation for every
  result;
- normalized outcomes/snapshots expose `structured` and `schemaError`; tool
  text and details use UTF-8-safe bounded renderings for large values;
- missing or invalid required structured output is a failed run with partial
  text retained, and all structured/schema-error state is cleared synchronously
  before follow-up dispatch so late send resolution cannot erase fresh data;
- named roles persist their schema, restore it during backend-native resume,
  compare active overrides with the live session contract, and refuse to
  silently downgrade invalid persisted contracts;
- workflow and standalone Pi paths share the bounded schema guard and
  terminating tool implementation;
- portable tests cover schema semantics/security bounds, linear extraction,
  Pi capture/reset and strict tool validation, a hermetic fake app-server
  exercising the real Codex backend, backend request contracts, role
  persistence, manager state transitions, output rendering, and schema-less
  regressions.

Structured result artifact persistence and Hunk summaries remain deferred to
Task D; Task B only persists the role's schema contract and exposes live run
results.

---

### Task C0 — Observability contracts and run-level workflow events — not started

The metadata/delivery groundwork described in §3 is implemented, but it does not include C0 durable IDs, an observability envelope/sink, or workflow run events.

Before changing workflow execution, add only the event/identity seams required by
Task C1 and the staged observability plan in
[`docs/observability-architecture.md`](docs/observability-architecture.md):

- mint durable run/agent identity before `backend.spawn()` while keeping
  `sa-N`/`btw-N` as display IDs;
- add a no-op, non-throwing observability sink boundary;
- model workflow **run-level** phase/log/settle events;
- keep agent lifecycle out of the workflow event vocabulary;
- preserve current `WorkflowDetails` and manager snapshots as the live TUI
  projections.

C0 must not add a daemon, database, model-visible API, child-hook claim map, or a
second agent lifecycle vocabulary. With a no-op sink, current behavior and tests
must remain unchanged.

---

### Task C1 — Unify workflow `agent()` with `SubagentManager` — not started

Goal: workflow scripts can choose harness:

```js
await agent("review this", {
  label: "codex review",
  harness: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  schema: FINDINGS,
});
```

Required behavior:

- consume the existing `SubagentOrigin: "workflow"` groundwork;
- have the workflow bridge attach bounded durable `workflowRunId`, workflow
  phase/index/label, and forced `autoDeliver: false` metadata before backend
  spawn;
- route workflow `agentFn` through the manager and wait for manager settlement;
- return `{ ok, output, structured?, error? }` to the workflow script;
- suppress standalone result follow-ups for workflow-owned agents;
- propagate workflow cancellation and shutdown to manager cancellation;
- keep phase/status/preview/usage/transcript visible in `/workflows`;
- show workflow-owned agents in `/subagents` with origin/workflow identity;
- support Pi, Claude, and Codex plus model/effort/schema selection.

The current Pi-only runner may exist only as temporary implementation scaffolding
inside C1. C1 acceptance requires deleting/retiring that execution path and any
fallback flag. **No Task D database work may start while both paths can run.**
Downstream consumers must see one manager-owned agent event vocabulary.

Durable IDs/origin must be available before child work starts or observed at the
manager boundary. Do not claim exact Pi child-hook attribution through a
post-construction map or process-wide environment variable; defer child-hook
claiming until a non-racy per-session API exists.

Acceptance:

- workflow scripts run Pi/Claude/Codex children;
- workflow explicit return values remain the source of truth;
- no duplicate parent follow-up is delivered;
- cancellation aborts workflow-owned manager agents;
- both dashboards retain their current information;
- repository tests/search prove the legacy runner cannot execute an agent.

---

### Task D — Observability and artifact/result integration

The canonical design, schema, security model, gates, and rollback points are in
[`docs/observability-architecture.md`](docs/observability-architecture.md).
Implement in this order only after C1 is accepted:

#### D1 — Minimal daemon and SQLite projections

- one local process for ingestion, SQLite WAL, read service, and later static
  UI;
- only `events`, `runs`, and `agents` application tables plus
  `PRAGMA user_version` migrations;
- daemon-assigned receive sequence, idempotent inserts, deterministic projection
  rebuild, and mandatory daemon-side re-redaction;
- bounded inline content only—no external blob tier, PostgreSQL, S3, Unix
  socket, remote auth, or native external-harness harvesting.

#### D2 — Pi/manager ingestion, protected spool, and autostart

- parent Pi hooks plus unified manager events are primary;
- workflow events remain run-level phase/log/settle only;
- producer redaction, batching, bounded spool/replay, and per-project
  disable/metadata/rich policy;
- subagents owns one guarded `ensureDaemon()` lifecycle; workflows never start a
  second daemon;
- enforce child deny paths for daemon tokens, DB/WAL/SHM, spool, config,
  existing workflow artifacts, and new run artifacts; verify `0700` directories
  and `0600` files;
- redact, then bound/truncate, then re-scan; store no unscanned bytes.

#### D3 — Read-only API and polling web UI

- authenticated run/agent/event/status/export reads;
- static no-build UI served by the daemon;
- sequence-cursor polling with retention-floor resync;
- no web controls and no SSE until dogfood proves polling insufficient.

#### D4 — Shared redacted artifacts and reconciliation

Create a shared redacted run artifact layout for:

- structured outputs;
- final reports;
- bounded transcripts;
- Hunk result comments when safe;
- role records pointing to latest artifacts.

Persist these for standalone and workflow-owned manager agents, closing
`TASK-D-001`. Reconcile existing bounded workflow/shared artifacts
idempotently as recovery/enrichment without overriding primary hook/manager
facts. Add age/DB/spool caps, offline purge, and redacted export.

Never expose the companion home to a child. If an agent must receive an output
artifact path, use a separate agent-owned path inside its cwd/configured
writable root (including Codex sandbox requirements), then import it through the
same bounds/redaction pipeline.

#### D5 — Dogfood and honest change summaries

Tune caps/indexes from measured local use before normalizing more tables.
Optionally add bounded changed-file summaries only after the timeline is useful;
shared-worktree results must be labelled `shared/unattributed`. Exact child-hook
or diff attribution requires a later non-racy API or worktree/atomic-patch
isolation and is not a v1 claim.

Task D acceptance includes the redaction leak evaluation, child deny-path tests,
projection replay/rebuild tests, daemon-outage tests, retention/purge/export,
and the rollback gates in the architecture document.

---

### Task E — Supervisor UX hardening

Current `/subagents` takeover already supports send/abort plumbing. Improve
reliability and visibility:

- show role in rows/header;
- show retryable provider errors distinctly if easy, but do not add new state;
- add dashboard action for inactive role resume after Task A;
- verify mid-run steering for Pi, Claude, Codex;
- ensure queued follow-ups are visible;
- add non-model-visible links to read-only web run/agent detail when available;
- show redaction, truncation, artifact recovery, and telemetry-gap badges without
  making the TUI depend on the database;
- optionally close `TASK-E-001` with a structured-output badge.

The live manager remains the authority for TUI actions. Web/daemon failure must
not disable supervision, and web controls remain deferred.

---

## 7. Verification commands

Smoke-load subagents only:

```bash
PI_OFFLINE=1 pi --no-extensions -e ~/Projects/pi-multi-agent/extensions/subagents/index.ts --list-models
```

Smoke-load workflows only:

```bash
PI_OFFLINE=1 pi --no-extensions -e ~/Projects/pi-multi-agent/extensions/workflows/index.ts --list-models
```

Full startup check:

```bash
PI_OFFLINE=1 pi --list-models
```

Workflow focused tests that currently pass in raw Node:

```bash
cd ~/Projects/pi-multi-agent/extensions/workflows
node --test --experimental-strip-types sandbox.test.ts controller.test.ts meta.test.ts serialization.test.ts
```

Some raw Node tests import Pi-injected packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) and may fail outside Pi’s extension loader. Prefer Pi smoke-load for extension compatibility.

Functional test pattern, burns model calls:

```bash
pi --no-extensions -e ~/Projects/pi-multi-agent/extensions/subagents/index.ts \
  --model gpt/gpt-5.5 \
  --print '<prompt that calls subagent_spawn + subagent_wait or subagent_followup>'
```

Blackboard tests need a git repo with a working-tree diff. Do not kill the Hunk PTY/session between test processes unless you expect comments to disappear.

---

## 8. Rollback notes

Settings backups from cutover exist as:

```text
~/.pi/agent/settings.json.bak-precutover-*
```

Old MVP was moved to:

```text
~/.pi/agent/extensions-disabled/multi-subagents-mvp-*
```

Rollback would involve moving current `extensions/{subagents,workflows,shared}` away, restoring old extension/settings, and restarting Pi. Prefer fixing forward unless the extension fails to load.

---

## 9. Current known caveats

- Workflow `agent()` is still Pi-only.
- Structured standalone results are live snapshot/tool data only; durable run
  artifacts and Hunk result summaries remain Task D.
- Hunk blackboard is ephemeral and requires repo/diff context.
- Error retry is parent-decided from error text; no special blocked state exists.
- API/provider daily caps can break subagents. If parent can continue afterward, retry failed cap-limited subagents once.

---

## 10. Recently completed changes

Completed on 2026-08-19:

1. Workflow DSL-first uplift:
   - `pipeline()`
   - `log()`
   - `cwd`
   - restricted `process.cwd()`
   - logs in UI/artifacts
   - dynamic phase guidance
   - no budget API

2. Subagent roles Phase 1:
   - `role` on `subagent_spawn`
   - `src/roles.ts`
   - persistent role files under `~/.pi/agent/multi-agent/roles/`
   - `subagent_followup`
   - `subagent_roles`
   - `subagent_forget`

3. Backend-native role resume:
   - `subagent_resume` routes current-session roles or reopens saved native history;
   - Pi, Claude, and Codex resume paths implemented and live-tested across fresh Pi processes;
   - process-safe role locks, trust revalidation, and Hunk refresh;
   - focused manager/lock tests and smoke-load verification.

4. Handover/skill updates:
   - this document rewritten;
   - project skill `use-multi-subagents-mvp` updated to describe current live setup and retry-on-transient-error behavior.

Completed on 2026-08-20:

1. Standalone structured outputs:
   - bounded `schema` on spawn and resume;
   - terminating Pi tool, native Codex `outputSchema`, persistent Claude JSON instructions;
   - shared extraction/validation and per-turn state isolation;
   - structured results and schema errors in normalized snapshots and tool/result delivery;
   - role schema persistence and portable regression coverage.
