import { isWorkflowRunId } from "./ids.ts";
import { truncateUtf8 } from "./text.ts";

export const WORKFLOW_METADATA_TEXT_MAX_BYTES = 256;
export const WORKFLOW_AGENT_INDEX_MAX = 1024;

export interface WorkflowOwnershipInput {
  readonly workflowRunId: unknown;
  readonly workflowAgentIndex: unknown;
  readonly workflowPhase?: unknown;
  readonly workflowLabel?: unknown;
}

export interface WorkflowOwnership {
  readonly workflowRunId: string;
  readonly workflowAgentIndex: number;
  readonly workflowPhase?: string;
  readonly workflowLabel?: string;
}

/** Validate and byte-bound workflow ownership before it enters manager state. */
export function boundWorkflowOwnership(
  input: WorkflowOwnershipInput,
): WorkflowOwnership {
  if (!isWorkflowRunId(input.workflowRunId)) {
    throw new Error(
      'Workflow-origin subagents require a valid workflowRunId ("wf_" plus 12 lowercase hex characters).',
    );
  }
  if (
    typeof input.workflowAgentIndex !== "number" ||
    !Number.isSafeInteger(input.workflowAgentIndex) ||
    input.workflowAgentIndex < 1 ||
    input.workflowAgentIndex > WORKFLOW_AGENT_INDEX_MAX
  ) {
    throw new Error(
      `Workflow-origin subagents require workflowAgentIndex between 1 and ${WORKFLOW_AGENT_INDEX_MAX}.`,
    );
  }
  const boundOptionalText = (value: unknown, field: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new Error(
        `Workflow-origin subagents require ${field} to be a string.`,
      );
    }
    return truncateUtf8(value, WORKFLOW_METADATA_TEXT_MAX_BYTES);
  };
  return Object.freeze({
    workflowRunId: input.workflowRunId,
    workflowAgentIndex: input.workflowAgentIndex,
    ...(input.workflowPhase === undefined
      ? {}
      : {
          workflowPhase: boundOptionalText(
            input.workflowPhase,
            "workflowPhase",
          ),
        }),
    ...(input.workflowLabel === undefined
      ? {}
      : {
          workflowLabel: boundOptionalText(
            input.workflowLabel,
            "workflowLabel",
          ),
        }),
  });
}
