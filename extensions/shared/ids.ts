import { randomUUID } from "node:crypto";

export type AgentId = `agent_${string}`;
export type TurnId = `turn_${string}`;
export type StandaloneRunId = `sa_${string}`;

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const AGENT_ID = new RegExp(`^agent_${UUID_V4}$`);
const TURN_ID = new RegExp(`^turn_${UUID_V4}$`);
const STANDALONE_RUN_ID = new RegExp(`^sa_${UUID_V4}$`);
const WORKFLOW_RUN_ID = /^wf_[0-9a-f]{12}$/;

export function mintAgentId(): AgentId {
  return `agent_${randomUUID()}`;
}

export function mintTurnId(): TurnId {
  return `turn_${randomUUID()}`;
}

export function mintStandaloneRunId(): StandaloneRunId {
  return `sa_${randomUUID()}`;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_ID.test(value);
}

export function isTurnId(value: unknown): value is TurnId {
  return typeof value === "string" && TURN_ID.test(value);
}

export function isStandaloneRunId(value: unknown): value is StandaloneRunId {
  return typeof value === "string" && STANDALONE_RUN_ID.test(value);
}

export function isWorkflowRunId(value: unknown): value is `wf_${string}` {
  return typeof value === "string" && WORKFLOW_RUN_ID.test(value);
}
