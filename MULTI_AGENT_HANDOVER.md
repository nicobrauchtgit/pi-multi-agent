# Multi-Agent Setup — Handover

_Last updated: 2026-08-24_

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
  src/manager.ts                   SubagentManager, live registry, workflow admission/atomic collect, wait/cancel/send, snapshots
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
  index.ts                         workflow tool, /workflows command, process-service consumer, progress/UI wiring
  sandbox.ts                       permission-mode child process IPC host
  sandbox-child.cjs                VM DSL bootstrap inside restricted child
  controller.ts                    run-wide agent scheduling/cancellation cap
  agent-bridge.ts                  manager-backed workflow agent adapter, watchdog, snapshot projection
  model.ts                         WorkflowDetails + formatting helpers
  prompt.ts                        model-facing workflow DSL guidance
  dashboard.ts                     /workflows dashboard
  artifacts.ts                     workflow.json/result.json/transcripts.json persistence
  meta.ts                          static metadata parser
  serialization.ts                 bounded JSON/atomic writes

extensions/shared/
  child-session.ts                 trust-aware child resources, child-load scope/filter, tool denylist, shutdown
  harness-routing.ts               task-kind preferences injected into subagent and workflow prompts
  ids.ts                           manager-owned run, agent, and turn IDs
  service-registry.ts              versioned globalThis manager/runtime ownership boundary
  workflow-metadata.ts             workflow ownership validation and UTF-8 bounds
  text.ts                          shared UTF-8-safe truncation
  json-schema.ts                   bounded JSON Schema guard + TypeBox adapter
  structured-output.ts             terminating Pi structured_output tool
  tool-call-timeout.ts             bounded child tool execution guard
  hunk-blackboard.ts               auto-provisioned Hunk shared blackboard
  activity-status.ts
  context-utilization.ts
  dashboard-state.ts
```

### One manager-owned agent path

Task C1 is complete. Standalone and workflow-owned agents now share one process-owned runtime:

```text
Standalone tools ─┐
                  ├─> SubagentManager ─> pi / claude / codex backends
Workflow agent() ─┘          │
                             └─> one agent lifecycle/event vocabulary
```

`extensions/subagents/index.ts` is the sole provider of the manager and managed runtime. `extensions/workflows/index.ts` resolves the process service lazily through the versioned `globalThis` registry, so separately evaluated extension modules and load order do not create duplicate managers. Owner token, epoch, and shutdown signal cover reload/session replacement. In-process Pi child resource reloads run inside a global `AsyncLocalStorage` scope, PackageManager's scoped settings getters are exact-realpath filtered, and the final loaded extension set is filtered again; children therefore neither load the orchestration entries nor acquire the parent service.

Every workflow agent lifecycle, snapshot, cancellation, and settlement is manager-owned. The old workflow child runner and its tests are deleted with no fallback flag.

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

The shared task preference map currently routes planning work to Claude and
implementation work to Codex. Every review uses two independent reviewers, one
Claude subagent and one Codex subagent, and the parent reconciles both results.
Both standalone and workflow prompt guidance receive the rendered map. The
parent model still chooses each model within its selected harness.

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

Workflow `agent()` is manager-backed and accepts:

```js
await agent("review this", {
  harness: "pi" | "claude" | "codex", // defaults to pi
  model: "backend-specific model hint",
  effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  schema: OBJECT_ROOT_JSON_SCHEMA,
  label: "bounded display label",
  phase: "bounded phase",
});
```

Pi model hints use `provider/id` or a resolvable bare id. Claude uses its native alias and Codex uses its model slug. Structured results, trust gating, Hunk prompts, child deny-lists, context/usage/transcript projection, and cancellation all flow through the same backend implementations as standalone agents. Workflow agents are role-less, visible in both TUIs, hidden from standalone model-facing subagent tools, and never auto-deliver a second parent follow-up.

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
  transcripts.json       bounded manager transcript/UI previews
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

### Task C1 — Unify workflow `agent()` with `SubagentManager` — completed 2026-08-22

Implemented and verified:

- `subagents/index.ts` owns one runtime, manager, and sink through a versioned
  `globalThis` registry that survives separate jiti module evaluation;
- workflows acquire the current epoch lazily, abort on reload/session
  replacement, and never capture a stale extension context or create a private
  runner;
- child Pi resource loading runs inside the global `AsyncLocalStorage` scope,
  exact-realpath filtering is applied to the scoped settings PackageManager
  actually reads, and a final loaded-extension filter provides defense in depth;
- `runWorkflowAgent()` combines FIFO global admission, durable reservation,
  pruning pin, settlement wait, and frozen bounded result copy; high-fanout
  churn cannot remove a result between wait and collection;
- workflow metadata is validated and UTF-8-byte-bounded before snapshots,
  events, artifacts, or TUI rendering; workflow roles/resume/send are rejected
  and persistence is additionally origin-gated;
- the DSL supports Pi, Claude, and Codex, backend-specific model hints, a
  shared effort scale, structured schemas, labels, and phases; backend-specific model hints;
- workflow cancellation, invocation cancellation, service replacement, and
  shutdown cancel admission waiters, active native work, and spawn races, then
  wait for cleanup within existing bounds;
- `/workflows` mirrors manager model/context/usage/preview/transcript/tool timing
  and state/schema errors while preserving workflow.json, result.json,
  transcripts.json, and explicit script returns; validated per-agent structured
  values stay in the explicit `agent()` result instead of being duplicated into
  every UI/checkpoint record;
- `/subagents` shows workflow ownership and permits abort but not steering;
  standalone model-facing tools still filter workflow origin;
- workflow origin forces `autoDeliver: false`; manager settlement cannot enqueue
  a duplicate parent message;
- `workflows/runner.ts` and its tests are deleted. Static removal tests reject
  Pi session constructors, runner calls, a fallback execution flag, or a second
  factory argument in workflow production code.

Acceptance evidence:

- hermetic service lifecycle, duplicate-module, admission, high-churn,
  cancellation, metadata, bridge, sandbox, dashboard, and artifact tests pass;
- the full default test/check/format/smoke/startup gate passes;
- the opt-in live workflow suite completes one structured Pi/Claude/Codex DSL
  matrix and one real Codex cancellation with settled artifacts.

### Task E — Supervisor UX hardening

Current `/subagents` takeover already supports send/abort plumbing. Improve
reliability and visibility:

- show role in rows/header;
- show retryable provider errors distinctly if easy, but do not add new state;
- add dashboard action for inactive role resume after Task A;
- verify mid-run steering for Pi, Claude, Codex;
- ensure queued follow-ups are visible;
- optionally close `TASK-E-001` with a structured-output badge.

### Task F1 — Automatic Pi subagent handoff — design accepted 2026-08-31

The accepted architecture direction is captured in
[`docs/subagent-automatic-handoff-architecture.md`](docs/subagent-automatic-handoff-architecture.md).
Automatic handoff is a Pi-backend-first subagent platform capability: a
configurable context threshold triggers a handoff prompt and continuation in a
fresh same-config child session. Claude/Codex adapters come only after the Pi
SDK path is proven.

Implementation is not started. Keep handoff independent of implementation,
review, workflow, and task-loop semantics.

### Task F2 — Coded implementation task loop — design accepted 2026-08-31

The accepted architecture direction is captured in
[`docs/implementation-task-loop-architecture.md`](docs/implementation-task-loop-architecture.md).
Implementation loops are durable parent-owned task controllers, not agent
sessions. They loop between implementation and review until `acceptance_met` is
proven by measurable code checks and `no_changes_requested` is set by review for
the same checkpoint.

Implementation is not started. Keep children unable to recursively orchestrate;
parent/task-loop controllers own all spawning, loop state, acceptance evidence,
and review issue communication.

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

Workflow focused tests:

```bash
cd ~/Projects/pi-multi-agent
npm run test:workflows
```

Opt-in live backend and C1 workflow matrices (use real credentials/model calls):

```bash
npm run test:live:backends
RUN_LIVE_WORKFLOW_TESTS=1 npm run test:live:workflows
# Optional Pi override, in provider/id form:
PI_LIVE_WORKFLOW_MODEL=github-copilot/gpt-5-mini npm run test:live:workflows
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

- Workflow and standalone agents share the global manager cap. Workflow calls wait
  in FIFO admission when the cap is full; standalone spawn and settled-agent restart
  remain fail-fast so a wide workflow can temporarily block new standalone work.
- Explicit cancellation force-settles a still-running native entry as interrupted
  once the backend acknowledges; a racing late completion cannot replace that result.
- Manager-backed workflow transcripts intentionally contain bounded UI previews.
- Structured standalone results are live snapshot/tool data only.
- Hunk blackboard is ephemeral and requires repo/diff context.
- Automatic Pi subagent handoff is design-only. The accepted direction is
  documented in
  [`docs/subagent-automatic-handoff-architecture.md`](docs/subagent-automatic-handoff-architecture.md):
  handoff is a Pi-backend-first subagent platform feature independent of task
  semantics.
- Coded implementation/review task loops are design-only. The accepted direction
  is documented in
  [`docs/implementation-task-loop-architecture.md`](docs/implementation-task-loop-architecture.md):
  task loops are durable acceptance/review controllers independent of agent IDs.
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

Completed on 2026-08-22:

1. Task C1 workflow-agent unification:
   - one subagents-owned process service across separately evaluated extensions;
   - manager-backed Pi/Claude/Codex workflow agents with shared model, effort,
     schema, trust, Hunk, cancellation, and concurrency behavior;
   - atomic bounded settlement collection under manager pruning pressure;
   - manager snapshot projection into workflow UI and artifacts;
   - origin-gated delivery, role persistence, model-facing tools, and steering;
   - complete deletion and static non-reachability proof for the old workflow
     child execution path;
   - hermetic full gates plus opt-in live matrix/cancellation verification.

Completed on 2026-08-23/24:

1. Retired daemon stack:
   - removed the old companion/producer/spool/redaction implementation from the
     active architecture;
   - kept the single manager-owned workflow agent path and no model-visible
     lifecycle split.
