# Multi-Agent Setup — Handover

_Last updated: 2026-08-19_

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

Unifying workflow `agent()` with `SubagentManager` is a major future task.

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
subagent_resume({ role, prompt, working_dir?, model?, reasoning_effort? })
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

### Task B — Structured outputs for standalone subagents

Workflow child agents already support `structured_output`. Bring a similar contract to standalone subagents.

Possible API:

```ts
subagent_spawn({
  prompt,
  name,
  harness,
  schema?: JsonSchema,
  role?: string,
  ...
})
```

Backend strategy:

- Pi: inject terminating `structured_output` tool, same as workflows.
- Claude/Codex: likely prompt for JSON and validate final output, unless native structured output support exists.

Result record should include:

```ts
structured?: unknown
schemaError?: string
```

Persist structured results into role/run artifact store and optionally post a Hunk summary.

Acceptance:

- Pi standalone structured result validates and is delivered to parent.
- Invalid structured output is surfaced as a clear error.
- Claude/Codex either validate final JSON or clearly report unsupported/validation failure.

---

### Task C — Unify workflow `agent()` with `SubagentManager`

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

Design constraints:

- Workflow-owned agents should not auto-deliver standalone result follow-ups.
- Workflow must still receive `{ ok, output, structured?, error? }`.
- Workflow progress should continue to show in `/workflows`.
- Ideally workflow-owned agents should also be visible in `/subagents`, marked with origin/workflow id.
- Keep current Pi-only workflow runner path until replacement is stable.

Likely implementation:

- Extend `SubagentOrigin` with `workflow`.
- Add `workflowRunId?: string` and `autoDeliver?: false` metadata to `SpawnTask` or manager spawn options.
- Manager settlement hook should suppress standalone result delivery for workflow-owned agents.
- Workflow `agentFn` routes through manager, waits for settlement, captures output/structured result.

Acceptance:

- Workflow can run Pi/Claude/Codex children.
- No duplicate parent follow-up for workflow-owned agents.
- Cancellation aborts workflow-owned manager agents.
- `/workflows` still has per-agent phase/status/preview.

---

### Task D — Better artifact/result integration

Create shared artifact layout, likely:

```text
~/.pi/agent/multi-agent/runs/<id>/
```

Expose artifact path in prompts when safe. For Codex sandbox constraints, either keep artifacts inside cwd or configure writable roots.

Integrate:

- structured outputs;
- final reports;
- bounded transcripts;
- Hunk result comments;
- role records pointing to latest artifacts.

---

### Task E — Supervisor UX hardening

Current `/subagents` takeover already supports send/abort plumbing. Improve reliability and visibility:

- show role in rows/header;
- show retryable provider errors distinctly if easy, but do not add new state;
- add dashboard action for inactive role resume after Task A;
- verify mid-run steering for Pi, Claude, Codex;
- ensure queued follow-ups are visible.

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
- Standalone subagents do not yet support schema/structured output.
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
