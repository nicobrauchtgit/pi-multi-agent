import { randomUUID } from "node:crypto";

export type AgentId = `agent_${string}`;
export type TurnId = `turn_${string}`;
export type EventId = `event_${string}`;
export type StandaloneRunId = `sa_${string}`;
export type ProducerId = `producer_${string}`;
export type TraceId = `pi-session:${string}`;
export type RootRunId = `pi-run:${string}`;

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const AGENT_ID = new RegExp(`^agent_${UUID_V4}$`);
const TURN_ID = new RegExp(`^turn_${UUID_V4}$`);
const EVENT_ID = new RegExp(`^event_${UUID_V4}$`);
const STANDALONE_RUN_ID = new RegExp(`^sa_${UUID_V4}$`);
const PRODUCER_ID = new RegExp(`^producer_${UUID_V4}$`);
const WORKFLOW_RUN_ID = /^wf_[0-9a-f]{12}$/;

export function mintAgentId(): AgentId {
  return `agent_${randomUUID()}`;
}

export function mintTurnId(): TurnId {
  return `turn_${randomUUID()}`;
}

export function mintEventId(): EventId {
  return `event_${randomUUID()}`;
}

export function mintStandaloneRunId(): StandaloneRunId {
  return `sa_${randomUUID()}`;
}

export function mintProducerId(): ProducerId {
  return `producer_${randomUUID()}`;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_ID.test(value);
}

export function isTurnId(value: unknown): value is TurnId {
  return typeof value === "string" && TURN_ID.test(value);
}

export function isEventId(value: unknown): value is EventId {
  return typeof value === "string" && EVENT_ID.test(value);
}

export function isStandaloneRunId(value: unknown): value is StandaloneRunId {
  return typeof value === "string" && STANDALONE_RUN_ID.test(value);
}

export function isProducerId(value: unknown): value is ProducerId {
  return typeof value === "string" && PRODUCER_ID.test(value);
}

export function isWorkflowRunId(value: unknown): value is `wf_${string}` {
  return typeof value === "string" && WORKFLOW_RUN_ID.test(value);
}

/** Pi session IDs are correlation metadata, not locally minted path fragments. */
export function traceIdFromPiSession(sessionId: string): TraceId {
  return `pi-session:${sessionId}`;
}

/** Pi session IDs are correlation metadata, not locally minted path fragments. */
export function rootRunIdFromPiSession(sessionId: string): RootRunId {
  return `pi-run:${sessionId}`;
}

export function parentIdentityFromPiSession(sessionId: string): {
  readonly traceId: TraceId;
  readonly rootRunId: RootRunId;
} {
  return {
    traceId: traceIdFromPiSession(sessionId),
    rootRunId: rootRunIdFromPiSession(sessionId),
  };
}

/** Fallback for tests/non-session callers. These IDs are never used as paths. */
export function mintEphemeralParentIdentity(): {
  readonly traceId: TraceId;
  readonly rootRunId: RootRunId;
} {
  const suffix = `ephemeral-${randomUUID()}`;
  return {
    traceId: `pi-session:${suffix}`,
    rootRunId: `pi-run:${suffix}`,
  };
}

/** Fallback for callers that only need a root run ID. It is never a path. */
export function mintEphemeralRootRunId(): RootRunId {
  return `pi-run:ephemeral-${randomUUID()}`;
}
