# Automatic Pi Subagent Handoff

_Status: first implementation slice in progress_
_Last updated: 2026-08-31_

This is a **subagent platform feature**. It is not specific to implementation
work, review work, workflows, or task loops.

Goal: when a Pi subagent's context gets too full, automatically ask it for a
handoff, start a fresh Pi SDK session with the same configuration, inject the
handoff, and continue under the same parent-facing subagent handle.

---

## 1. Scope

### In scope

- Pi backend first.
- Fresh Pi SDK session per context segment.
- Stable logical subagent handle, e.g. `sa-3`.
- Threshold-based rollover at safe idle turn boundaries in the first slice.
- Fully automatic mid-run handoff at assistant/tool boundaries in a later slice.
- Declarative Pi SDK configuration only.
- Parent-visible handoff failures and summaries.

### Out of scope

- Claude/Codex support in v1.
- Implementation/review task-loop semantics.
- Child-created subagents or workflows.
- Pi compaction as the primary mechanism.
- New model-visible lifecycle states.

---

## 2. Module boundary

Add a dedicated module:

```text
extensions/subagents/src/handoff/
  policy.ts       threshold config and decisions
  prompt.ts       handoff and continuation prompt loading
  schema.ts       handoff document shape
  controller.ts   wraps 1..N Pi SDK sessions as one logical session
```

Responsibility split:

```text
pi backend              creates one normal Pi SDK child session
handoff controller      manages segment rollover
SubagentManager         tracks one logical subagent handle
task-loop controller    later consumes logical subagents, not segments
```

---

## 3. Pi SDK usage

Use Pi SDK primitives directly:

- `createAgentSession(...)` for every fresh segment;
- `SessionManager.create(cwd)` for new fresh-context session files;
- `DefaultResourceLoader` and `SettingsManager` for declarative setup;
- `customTools` / `tools` for per-session capabilities;
- `session.subscribe(...)` for lifecycle events;
- `session.getContextUsage()` for cutoff decisions;
- `session.prompt()`, `session.steer()`, and `session.followUp()` for prompt
  flow;
- `session.abort()` and `session.dispose()` for cleanup.

Do **not** mutate `process.env` for handoff state.

---

## 4. Runtime shape

```text
logical subagent sa-3
  ├─ segment 1: Pi AgentSession
  ├─ handoff
  ├─ segment 2: Pi AgentSession
  ├─ handoff
  └─ segment 3: Pi AgentSession → final result
```

The parent keeps using the logical handle:

```text
subagent_check(sa-3)
subagent_wait(sa-3)
subagent_cancel(sa-3)
subagent_followup(sa-3)
```

Internally, each segment has its own Pi `sessionFile` and native `sessionId` for
diagnostics/resume history.

---

## 5. Cutoff policy

At safe boundaries, sample context usage:

```text
message_end / turn_end / agent_settled
  → session.getContextUsage()
  → threshold reached?
  → request handoff
```

Avoid handoff during:

- streaming text;
- active tool calls;
- unknown mid-turn state.

Policy should be configurable and model-window-aware:

```text
tokenThreshold: 120k default candidate
reserveTokensForHandoff: 8k-16k
ratioThreshold: fallback for smaller context windows
```

The effective cutoff should be earlier than the point where the handoff prompt
itself may overflow.

---

## 6. Handoff flow

```text
1. Active segment reaches cutoff.
2. Handoff controller requests a concise handoff.
3. Handoff output is captured through an internal handoff schema/tool/path.
4. Handoff does not satisfy or fail the caller's final structured-output schema.
5. Old segment is closed or retained only as diagnostic history.
6. Fresh Pi SDK session is created with the same declarative config.
7. Fresh segment receives original prompt + latest handoff.
8. Logical subagent continues.
```

Handoff is continuation state, not task completion.

---

## 7. Handoff document

The handoff document should be bounded and generic:

```text
summary
current state
files touched
tests/checks run
open issues
next steps
risks
```

It should not contain implementation-loop-specific gates. The same handoff
mechanism must work for any Pi subagent.

---

## 8. Main implementation risks

1. Current manager treats one backend session settlement as subagent settlement.
   Handoff needs segment settlement separate from logical settlement.
2. Workflow `agent()` currently collects one manager entry. If workflow agents
   later use handoff, collection must wait for logical completion.
3. Structured-output contracts currently apply to normal turns. Handoff needs a
   separate internal channel.
4. Role records currently point to one latest native locator. Handoff needs role
   continuity over a chain of segments.
5. Context usage may update too late if the threshold is too aggressive. Keep a
   reserve.

---

## 9. Acceptance criteria

This feature is designed correctly when:

- Pi subagents can roll to a fresh Pi SDK session at cutoff;
- the parent still sees one stable logical subagent handle;
- handoff output is separate from user-facing final results and schemas;
- cancellation/wait/check/follow-up operate on the logical handle;
- no task-loop or review semantics leak into the handoff module;
- non-Pi backends remain explicitly unsupported until adapted.

---

## 10. Current implementation slice

Implemented so far:

- handoff policy module with token/context-window threshold decisions;
- markdown prompt files for continuation/handoff text;
- bounded handoff document formatter/recorder;
- Pi backend wrapper that rolls over to a fresh Pi session before a new idle
  follow-up when the previous segment is past the threshold;
- manager `Handoff` event handling;
- no support yet for schema-bearing Pi handoff segments or mid-run handoff while
  a native Pi run is actively streaming.
