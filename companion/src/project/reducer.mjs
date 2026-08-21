const RUN_EVENT_KINDS = new Set([
  "run.started",
  "turn.started",
  "message.user",
  "message.assistant",
  "tool.started",
  "tool.finished",
  "turn.settled",
  "run.settled",
  "session.compacted",
  "workflow.started",
  "workflow.phase",
  "workflow.log",
  "workflow.settled",
]);

const AGENT_EVENT_KINDS = new Set([
  "agent.created",
  "agent.run_started",
  "agent.message",
  "agent.tool_started",
  "agent.tool_finished",
  "agent.usage",
  "agent.meta",
  "agent.error",
  "agent.settled",
]);

const AGENT_META_PROJECTION_KEYS = Object.freeze([
  "displayId",
  "update",
  "modelLabel",
  "contextWindow",
  "hasSessionFile",
  "hasNativeSessionId",
  "queuedCount",
  "queuedSteerCount",
  "queuedFollowUpCount",
]);
const AGENT_USAGE_PROJECTION_KEYS = Object.freeze([
  "displayId",
  "tokens",
  "contextWindow",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function string(value) {
  return typeof value === "string" ? value : null;
}

function integer(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function parseMetadata(value) {
  if (value && typeof value === "object") return { ...value };
  if (typeof value !== "string") return {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function projectionPayload(payload, keys) {
  const projected = {};
  for (const key of keys) {
    const value = payload[key];
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      projected[key] = value;
    }
  }
  return projected;
}

export function inferRunKind(runId) {
  if (runId.startsWith("wf_")) return "workflow";
  if (runId.startsWith("sa_")) return "standalone";
  if (runId.startsWith("pi-run:")) return "session";
  return "unknown";
}

function baseRun(event) {
  const runKind = inferRunKind(event.runId);
  return {
    run_id: event.runId,
    trace_id: event.traceId,
    parent_run_id: event.parentRunId,
    run_kind: runKind,
    project_id: event.projectId,
    project_root: event.projectRoot,
    session_id:
      runKind === "session" ? event.runId.slice("pi-run:".length) : null,
    name: null,
    current_phase: null,
    status: "unknown",
    started_at_ms: null,
    settled_at_ms: null,
    error_text: null,
    recovered_from_artifact: 0,
    content_mode: event.capture?.contentMode ?? "rich",
    last_seq: 0,
    metadata_json: { incomplete: true },
  };
}

function baseAgent(event) {
  const payload = object(event.payload);
  return {
    agent_id: event.agentId,
    run_id: event.runId,
    local_id: string(payload.displayId),
    workflow_index: integer(payload.workflowAgentIndex),
    origin: ["model", "btw", "workflow"].includes(payload.origin)
      ? payload.origin
      : "model",
    backend: ["pi", "claude", "codex"].includes(payload.backend)
      ? payload.backend
      : "pi",
    role: string(payload.role),
    title: string(payload.title),
    cwd: event.projectRoot,
    model: string(payload.modelLabel),
    native_session_id: string(payload.nativeSessionId),
    status: "unknown",
    current_turn_id: event.turnId,
    started_at_ms: null,
    settled_at_ms: null,
    error_text: null,
    final_preview: null,
    last_seq: 0,
    metadata_json: { incomplete: true },
  };
}

function nextMetadata(current, event, extra = {}) {
  return {
    ...parseMetadata(current),
    ...extra,
    lastEventKind: event.eventKind,
  };
}

function normalizeRunStatus(value) {
  if (value === "completed" || value === "done") return "completed";
  if (value === "failed" || value === "error" || value === "spawn_failed")
    return "failed";
  if (value === "aborted" || value === "interrupted") return "aborted";
  if (value === "running") return "running";
  return "unknown";
}

function projectRun(current, event) {
  const payload = object(event.payload);
  const run = current
    ? { ...current, metadata_json: parseMetadata(current.metadata_json) }
    : baseRun(event);
  if (event.seq <= run.last_seq) return null;
  run.trace_id = run.trace_id ?? event.traceId;
  run.parent_run_id = run.parent_run_id ?? event.parentRunId;
  run.project_id = run.project_id ?? event.projectId;
  run.project_root = run.project_root ?? event.projectRoot;
  run.content_mode = event.capture?.contentMode ?? run.content_mode;
  run.last_seq = event.seq;
  run.metadata_json = nextMetadata(run.metadata_json, event);

  switch (event.eventKind) {
    case "run.started":
      run.status = "running";
      run.started_at_ms = event.occurredAtMs ?? run.started_at_ms;
      run.session_id = string(payload.sessionId) ?? run.session_id;
      run.name = string(payload.name) ?? run.name;
      run.metadata_json = nextMetadata(run.metadata_json, event, {
        incomplete: false,
      });
      break;
    case "workflow.started":
      run.run_kind = "workflow";
      run.status = "running";
      run.started_at_ms = event.occurredAtMs ?? run.started_at_ms;
      run.name = string(payload.name) ?? run.name;
      run.metadata_json = nextMetadata(run.metadata_json, event, {
        incomplete: false,
      });
      break;
    case "workflow.phase":
      run.current_phase = string(payload.phase) ?? run.current_phase;
      break;
    case "workflow.settled":
    case "run.settled": {
      const rawOutcome = string(payload.status) ?? string(payload.outcome);
      run.status = normalizeRunStatus(rawOutcome);
      run.settled_at_ms = event.occurredAtMs ?? run.settled_at_ms;
      run.error_text =
        string(payload.error) ?? string(payload.message) ?? run.error_text;
      run.metadata_json = nextMetadata(run.metadata_json, event, {
        rawOutcome,
      });
      break;
    }
    case "turn.started":
      if (run.status === "unknown") run.status = "running";
      run.started_at_ms = run.started_at_ms ?? event.occurredAtMs;
      break;
    case "turn.settled":
      run.metadata_json = nextMetadata(run.metadata_json, event, {
        lastTurnOutcome: string(payload.status) ?? string(payload.outcome),
      });
      break;
    case "session.compacted":
      run.metadata_json = nextMetadata(run.metadata_json, event, {
        compacted: true,
      });
      break;
    default:
      break;
  }
  return run;
}

function projectAgent(current, event) {
  const payload = object(event.payload);
  const agent = current
    ? { ...current, metadata_json: parseMetadata(current.metadata_json) }
    : baseAgent(event);
  if (event.seq <= agent.last_seq) return null;
  const wasTerminal = agent.status === "done" || agent.status === "error";
  agent.last_seq = event.seq;
  agent.metadata_json = nextMetadata(agent.metadata_json, event);

  switch (event.eventKind) {
    case "agent.created":
      agent.local_id = string(payload.displayId) ?? agent.local_id;
      agent.workflow_index =
        integer(payload.workflowAgentIndex) ?? agent.workflow_index;
      if (["model", "btw", "workflow"].includes(payload.origin))
        agent.origin = payload.origin;
      if (["pi", "claude", "codex"].includes(payload.backend))
        agent.backend = payload.backend;
      agent.role = string(payload.role) ?? agent.role;
      agent.title = string(payload.title) ?? agent.title;
      if (!wasTerminal) agent.status = "running";
      agent.started_at_ms = agent.started_at_ms ?? event.occurredAtMs;
      agent.metadata_json = nextMetadata(agent.metadata_json, event, {
        incomplete: false,
        resumed: payload.resumed === true,
      });
      break;
    case "agent.run_started": {
      const distinctTurn = Boolean(
        event.turnId && event.turnId !== agent.current_turn_id,
      );
      if (!wasTerminal || distinctTurn) {
        agent.status = "running";
        agent.current_turn_id = event.turnId ?? agent.current_turn_id;
        agent.started_at_ms = agent.started_at_ms ?? event.occurredAtMs;
        if (wasTerminal) {
          agent.settled_at_ms = null;
          agent.error_text = null;
        }
      }
      agent.local_id = string(payload.displayId) ?? agent.local_id;
      agent.metadata_json = nextMetadata(agent.metadata_json, event, {
        turnNumber: integer(payload.turnNumber),
      });
      break;
    }
    case "agent.meta":
      agent.local_id = string(payload.displayId) ?? agent.local_id;
      agent.model = string(payload.modelLabel) ?? agent.model;
      agent.metadata_json = nextMetadata(agent.metadata_json, event, {
        meta: projectionPayload(payload, AGENT_META_PROJECTION_KEYS),
      });
      break;
    case "agent.usage":
      agent.metadata_json = nextMetadata(agent.metadata_json, event, {
        usage: projectionPayload(payload, AGENT_USAGE_PROJECTION_KEYS),
      });
      break;
    case "agent.error":
      agent.error_text = string(payload.message) ?? agent.error_text;
      break;
    case "agent.settled": {
      agent.status = payload.status === "done" ? "done" : "error";
      agent.settled_at_ms = event.occurredAtMs ?? agent.settled_at_ms;
      agent.error_text =
        string(payload.error) ??
        string(payload.schemaError) ??
        agent.error_text;
      agent.final_preview = string(payload.finalPreview) ?? agent.final_preview;
      agent.metadata_json = nextMetadata(agent.metadata_json, event, {
        rawOutcome: string(payload.outcome),
      });
      break;
    }
    default:
      agent.local_id = string(payload.displayId) ?? agent.local_id;
      break;
  }
  return agent;
}

/** Pure projection reducer: no I/O, clock, randomness, or ambient state. */
export function reduceProjection(current, event) {
  if (!event || !Number.isSafeInteger(event.seq) || event.seq <= 0) {
    throw new Error("invalid-reducer-event");
  }
  if (RUN_EVENT_KINDS.has(event.eventKind)) {
    if (!event.runId) return Object.freeze({ run: null, agent: null });
    return Object.freeze({ run: projectRun(current.run, event), agent: null });
  }
  if (AGENT_EVENT_KINDS.has(event.eventKind)) {
    if (!event.runId || !event.agentId)
      return Object.freeze({ run: null, agent: null });
    let run = projectRun(current.run, event);
    const agent = projectAgent(current.agent, event);
    if (run && run.run_kind === "standalone") {
      const payload = object(event.payload);
      if (event.eventKind === "agent.created") {
        run.status = "running";
        run.started_at_ms = run.started_at_ms ?? event.occurredAtMs;
        run.name = string(payload.title) ?? run.name;
        run.metadata_json = nextMetadata(run.metadata_json, event, {
          incomplete: false,
          currentTurnId: event.turnId,
        });
      } else if (event.eventKind === "agent.run_started") {
        const currentTurn =
          string(current.agent?.current_turn_id) ??
          string(parseMetadata(current.run?.metadata_json).currentTurnId);
        const distinctTurn = Boolean(
          event.turnId && event.turnId !== currentTurn,
        );
        if (
          !["completed", "failed", "aborted"].includes(run.status) ||
          distinctTurn
        ) {
          run.status = "running";
          if (distinctTurn) run.settled_at_ms = null;
        }
        run.metadata_json = nextMetadata(run.metadata_json, event, {
          currentTurnId: event.turnId,
        });
      } else if (event.eventKind === "agent.settled") {
        const rawOutcome = string(payload.outcome) ?? string(payload.status);
        run.status = normalizeRunStatus(rawOutcome);
        run.settled_at_ms = event.occurredAtMs ?? run.settled_at_ms;
        run.error_text =
          string(payload.error) ??
          string(payload.schemaError) ??
          run.error_text;
        run.metadata_json = nextMetadata(run.metadata_json, event, {
          rawOutcome,
        });
      }
    }
    return Object.freeze({ run, agent });
  }
  return Object.freeze({ run: null, agent: null });
}

export function isProjectingKind(kind) {
  return RUN_EVENT_KINDS.has(kind) || AGENT_EVENT_KINDS.has(kind);
}
