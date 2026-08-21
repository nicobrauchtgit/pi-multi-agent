import * as path from "node:path";
import { isWorkflowRunId } from "../shared/observability/ids.ts";
import { truncateUtf8 } from "../shared/text.ts";
import {
  WORKFLOW_AGENT_INDEX_MAX,
  WORKFLOW_METADATA_TEXT_MAX_BYTES,
} from "../shared/workflow-metadata.ts";
import type { AgentRecord, TranscriptEntry, WorkflowDetails } from "./model.ts";
import { MAX_AGENT_CALLS } from "./controller.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

const ARTIFACT_TRANSCRIPT_MAX_BYTES = 32 * 1024;
const ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;
const WORKFLOW_JSON_MAX_BYTES = 1024 * 1024;
const ARTIFACT_ERROR_MAX_BYTES = 16 * 1024;
const ARTIFACT_SCHEMA_ERROR_MAX_BYTES = 8 * 1024;
const ARTIFACT_DESCRIPTION_MAX_BYTES = 8 * 1024;
const ARTIFACT_LOG_ENTRY_MAX_BYTES = 2 * 1024;
const ARTIFACT_PREVIEW_MAX_BYTES = 2 * 1024;
const ARTIFACT_IDENTIFIER_MAX_BYTES = 1024;
export const WORKFLOW_CHECKPOINT_INTERVAL_MS = 500;
const ENTRY_TRUNCATION_MARKER = "\n[entry truncated]";
const TRANSCRIPT_TRUNCATION_MARKER =
  "[artifact transcript truncated: older entries omitted]";

function textBytes(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function boundEntry(entry: TranscriptEntry, maxBytes: number) {
  if (textBytes(entry.text) <= maxBytes) return { ...entry };
  const markerBytes = textBytes(ENTRY_TRUNCATION_MARKER);
  const text =
    maxBytes > markerBytes
      ? `${truncateUtf8(entry.text, maxBytes - markerBytes)}${ENTRY_TRUNCATION_MARKER}`
      : truncateUtf8(ENTRY_TRUNCATION_MARKER, maxBytes);
  return { ...entry, text };
}

/** Keep the initial prompt plus the newest useful context within the artifact cap. */
export function boundedArtifactTranscript(
  transcript: TranscriptEntry[],
  options: { maxBytes?: number; entryMaxBytes?: number } = {},
) {
  if (transcript.length === 0) return [];
  const maxBytes = Math.max(
    256,
    options.maxBytes ?? ARTIFACT_TRANSCRIPT_MAX_BYTES,
  );
  const entryMaxBytes = Math.max(
    64,
    Math.min(
      maxBytes,
      options.entryMaxBytes ?? ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES,
    ),
  );
  const bounded = transcript.map((entry) => boundEntry(entry, entryMaxBytes));
  if (
    bounded.reduce((total, entry) => total + textBytes(entry.text), 0) <=
    maxBytes
  ) {
    return bounded;
  }

  const initialIndex = transcript.findIndex((entry) => entry.role === "user");
  const initial = boundEntry(
    transcript[initialIndex >= 0 ? initialIndex : 0],
    Math.min(entryMaxBytes, maxBytes - textBytes(TRANSCRIPT_TRUNCATION_MARKER)),
  );
  const marker: TranscriptEntry = {
    role: "toolResult",
    name: "transcript",
    text: TRANSCRIPT_TRUNCATION_MARKER,
  };
  let remaining = maxBytes - textBytes(initial.text) - textBytes(marker.text);
  const tail: TranscriptEntry[] = [];

  for (
    let index = transcript.length - 1;
    index >= 0 && remaining > 0;
    index--
  ) {
    if (index === initialIndex || (initialIndex < 0 && index === 0)) continue;
    const entry = boundEntry(
      transcript[index],
      Math.min(entryMaxBytes, remaining),
    );
    tail.push(entry);
    remaining -= textBytes(entry.text);
  }

  tail.reverse();
  return [initial, marker, ...tail];
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function finite(value: number | undefined, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function boundedAgentRecord(agent: AgentRecord): AgentRecord {
  const bounded: AgentRecord = {
    index: Math.max(
      1,
      Math.min(
        WORKFLOW_AGENT_INDEX_MAX,
        Number.isSafeInteger(agent.index) ? agent.index : 1,
      ),
    ),
    label: truncateUtf8(agent.label, WORKFLOW_METADATA_TEXT_MAX_BYTES),
    state:
      agent.state === "running" || agent.state === "error"
        ? agent.state
        : "done",
    startedAt: finite(agent.startedAt),
    preview: truncateUtf8(agent.preview, ARTIFACT_PREVIEW_MAX_BYTES),
    usage: {
      input: finite(agent.usage?.input),
      output: finite(agent.usage?.output),
      cacheRead: finite(agent.usage?.cacheRead),
      cacheWrite: finite(agent.usage?.cacheWrite),
      cost: finite(agent.usage?.cost),
      turns: Math.floor(finite(agent.usage?.turns)),
      ...(agent.usage?.contextTokens === undefined
        ? {}
        : { contextTokens: finite(agent.usage.contextTokens) }),
    },
    transcript: Array.isArray(agent.transcript) ? agent.transcript : [],
  };
  if (agent.phase !== undefined) {
    bounded.phase = truncateUtf8(agent.phase, WORKFLOW_METADATA_TEXT_MAX_BYTES);
  }
  if (agent.displayId !== undefined) {
    bounded.displayId = truncateUtf8(
      agent.displayId,
      ARTIFACT_IDENTIFIER_MAX_BYTES,
    );
  }
  if (agent.agentId !== undefined) {
    bounded.agentId = truncateUtf8(
      agent.agentId,
      ARTIFACT_IDENTIFIER_MAX_BYTES,
    );
  }
  if (
    agent.harness === "pi" ||
    agent.harness === "claude" ||
    agent.harness === "codex"
  ) {
    bounded.harness = agent.harness;
  }
  if (agent.model !== undefined) {
    bounded.model = truncateUtf8(agent.model, ARTIFACT_IDENTIFIER_MAX_BYTES);
  }
  if (agent.contextWindow !== undefined) {
    bounded.contextWindow = finite(agent.contextWindow);
  }
  if (agent.finishedAt !== undefined) {
    bounded.finishedAt = finite(agent.finishedAt);
  }
  if (agent.error !== undefined) {
    bounded.error = truncateUtf8(agent.error, ARTIFACT_ERROR_MAX_BYTES);
  }
  if (agent.schemaError !== undefined) {
    bounded.schemaError = truncateUtf8(
      agent.schemaError,
      ARTIFACT_SCHEMA_ERROR_MAX_BYTES,
    );
  }
  return bounded;
}

function serializeWorkflowSummary(compact: WorkflowDetails) {
  const serialize = (value: WorkflowDetails) => JSON.stringify(value, null, 2);
  let serialized = serialize(compact);
  if (textBytes(serialized) <= WORKFLOW_JSON_MAX_BYTES) return serialized;

  // Degrade optional rich fields individually while preserving the run and
  // every agent's status/identity. Never replace the whole run with the generic
  // safeStringify truncation stub.
  const degraded: WorkflowDetails = {
    ...compact,
    description:
      compact.description === undefined
        ? undefined
        : truncateUtf8(compact.description, 2 * 1024),
    logs: compact.logs.slice(-8).map((log) => truncateUtf8(log, 512)),
    phases: compact.phases.map((phase) => ({
      title: phase.title,
      ...(phase.detail === undefined
        ? {}
        : { detail: truncateUtf8(phase.detail, 512) }),
    })),
    agents: compact.agents.map((agent) => ({
      ...agent,
      preview: truncateUtf8(agent.preview, 512),
      ...(agent.model === undefined
        ? {}
        : { model: truncateUtf8(agent.model, 256) }),
      ...(agent.error === undefined
        ? {}
        : { error: truncateUtf8(agent.error, 2 * 1024) }),
      ...(agent.schemaError === undefined
        ? {}
        : { schemaError: truncateUtf8(agent.schemaError, 2 * 1024) }),
    })),
  };
  if (compact.description === undefined) delete degraded.description;
  serialized = serialize(degraded);
  if (textBytes(serialized) <= WORKFLOW_JSON_MAX_BYTES) return serialized;
  throw new Error(
    `workflow.json core state exceeded ${WORKFLOW_JSON_MAX_BYTES} bytes after per-field bounds`,
  );
}

export function persistWorkflowJson(runDir: string, details: WorkflowDetails) {
  if (!isWorkflowRunId(details.runId)) {
    throw new Error(
      `Invalid workflow run id for artifact persistence: ${details.runId}`,
    );
  }
  const boundedDetails: WorkflowDetails = {
    runId: details.runId,
    ...(details.sessionId === undefined
      ? {}
      : {
          sessionId: truncateUtf8(
            details.sessionId,
            ARTIFACT_IDENTIFIER_MAX_BYTES,
          ),
        }),
    ...(details.name === undefined
      ? {}
      : {
          name: truncateUtf8(details.name, WORKFLOW_METADATA_TEXT_MAX_BYTES),
        }),
    ...(details.description === undefined
      ? {}
      : {
          description: truncateUtf8(
            details.description,
            ARTIFACT_DESCRIPTION_MAX_BYTES,
          ),
        }),
    background: details.background === true,
    status: details.status,
    startedAt: finite(details.startedAt),
    ...(details.finishedAt === undefined
      ? {}
      : { finishedAt: finite(details.finishedAt) }),
    phases: details.phases.slice(0, 64).map((phase) => ({
      title: truncateUtf8(phase.title, WORKFLOW_METADATA_TEXT_MAX_BYTES),
      ...(phase.detail === undefined
        ? {}
        : {
            detail: truncateUtf8(
              phase.detail,
              WORKFLOW_METADATA_TEXT_MAX_BYTES,
            ),
          }),
    })),
    ...(details.currentPhase === undefined
      ? {}
      : {
          currentPhase: truncateUtf8(
            details.currentPhase,
            WORKFLOW_METADATA_TEXT_MAX_BYTES,
          ),
        }),
    agents: details.agents.slice(0, MAX_AGENT_CALLS).map(boundedAgentRecord),
    ...(details.result === undefined ? {} : { result: details.result }),
    logs: details.logs
      .slice(-80)
      .map((log) => truncateUtf8(log, ARTIFACT_LOG_ENTRY_MAX_BYTES)),
    ...(details.error === undefined
      ? {}
      : { error: truncateUtf8(details.error, ARTIFACT_ERROR_MAX_BYTES) }),
  };
  const transcripts = Object.fromEntries(
    boundedDetails.agents.map((agent) => [
      agent.index,
      boundedArtifactTranscript(agent.transcript),
    ]),
  );
  writeRunFile(
    runDir,
    "transcripts.json",
    safeStringify(transcripts, { maxBytes: 2 * 1024 * 1024 }),
  );
  if (boundedDetails.result !== undefined) {
    writeRunFile(
      runDir,
      "result.json",
      safeStringify(boundedDetails.result, { maxBytes: 1024 * 1024 }),
    );
  }
  const compact: WorkflowDetails = {
    ...boundedDetails,
    ...(boundedDetails.result !== undefined
      ? { result: "[stored in result.json]", resultArtifact: "result.json" }
      : {}),
    transcriptArtifact: "transcripts.json",
    agents: boundedDetails.agents.map((agent) => ({
      ...agent,
      transcript: [],
    })),
  };
  writeRunFile(runDir, "workflow.json", serializeWorkflowSummary(compact));
}

/** Coalesce live checkpoints while keeping final persistence synchronous. */
export function createWorkflowPersistence(
  runDir: string,
  details: WorkflowDetails,
  options: {
    intervalMs?: number;
    persist?: (runDir: string, details: WorkflowDetails) => void;
  } = {},
) {
  const intervalMs = Math.max(
    0,
    options.intervalMs ?? WORKFLOW_CHECKPOINT_INTERVAL_MS,
  );
  const persist = options.persist ?? persistWorkflowJson;
  let lastPersistedAt = Date.now();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const savePending = () => {
    timer = undefined;
    if (!dirty) return;
    try {
      persist(runDir, details);
      dirty = false;
      lastPersistedAt = Date.now();
    } catch {
      // Final flush retries and reports persistence failures synchronously.
    }
  };

  return {
    checkpoint(options: { immediate?: boolean } = {}) {
      dirty = true;
      if (options.immediate) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        savePending();
        return;
      }
      if (timer) return;
      const delay = Math.max(0, intervalMs - (Date.now() - lastPersistedAt));
      if (delay === 0) {
        savePending();
        return;
      }
      timer = setTimeout(savePending, delay);
    },
    flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      persist(runDir, details);
      dirty = false;
      lastPersistedAt = Date.now();
    },
  };
}
