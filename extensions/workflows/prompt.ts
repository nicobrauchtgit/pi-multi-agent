import {
  countStates,
  formatElapsed,
  recentWorkflowLogs,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "JavaScript workflow script. May start with optional `export const meta = {...}` documentation, then use `phase()`, `log()`, `agent()`, `parallel()`, `pipeline()`, `args`, `cwd`, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Run in the background: the tool returns a run id immediately and you receive a follow-up message when the workflow finishes. Defaults to false (blocking with live progress).",
};

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "The workflow tool is only to be called when the user says 'ultracode' or specifically requests a workflow run.",
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Use this when a task benefits from fanning work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines). Do not call it for ordinary single-agent work.",
  "The script runs as an async function body with these globals:",
  "• export const meta = { name, description, phases?: [{ title, detail? }] } — optional documentation for the progress UI. `meta.phases` does not drive execution; live progress is driven by runtime `phase(title)` calls.",
  "• phase(title) — mark the current phase at runtime. It may use a documented title from `meta.phases` or introduce a new dynamic phase.",
  "• log(message) — append a bounded script log line for progress/debug notes. Use sparingly for meaningful milestones, decisions, and handoff summaries; do not stream noisy output.",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? }) — run ONE subagent in an isolated context and wait for it. Always resolves to { ok, output, structured?, error? }. Check `ok` before using the result. When you pass a JSON `schema`, `structured` holds the validated object on success. `model`/`provider` override the session model; `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). Children receive normal built-ins and trust-appropriate extensions, settings, skills, and AGENTS.md context, but cannot recursively orchestrate or ask the user.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument agent thunks concurrently and return results in order. Concurrency is globally capped at 4 for the run. Use it for fan-out where each child can work independently.",
  "• await pipeline(items, ...stages) — run each item through sequential handover stages while different items fan out concurrently. Each stage receives `(previous, original, index)` and may return text, structured agent results, or any JSON-serializable value for the next stage. Use it for per-file/per-module review chains and explicit handoff between analysis, critique, and synthesis steps.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "• cwd and process.cwd() — the parent working directory string for path-aware prompts and reports.",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or unrestricted process APIs. A run may make at most 32 agent calls and has no overall deadline. There is no budget API. Each agent must receive its first assistant response event within 45 seconds so silent provider requests fail clearly; after that, agent() has no wall-clock deadline. Each individual child tool call times out independently after 3 minutes, becomes an error tool result, and leaves the agent loop free to recover. Use map/filter/if/await/template strings to orchestrate, and `return` a JSON-serializable aggregate.",
  "Pass a `schema` to agent() whenever a later step branches on the result, so you get typed fields instead of prose. There is no resume: a failed run is simply re-run. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Example:",
  "export const meta = { name: 'reliability-review', description: 'Review modules for reliability risks, then report', phases: [{ title: 'Scan' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "log(`Scanning ${args.files.length} file(s) for reliability risks`)",
  "const scans = await parallel(args.files.map((f) => () => agent(`Review ${f} for correctness and reliability risks.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS })))",
  "const findings = scans.filter((r) => r.ok).map((r) => r.structured)",
  "phase('Report')",
  "const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, { label: 'report', phase: 'Report' })",
  "if (!report.ok) log(`report failed: ${report.error}`)",
  "return { findings, report: report.ok ? report.output : report.error }",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Only when the user says ultracode or explicitly requests workflow: orchestrate isolated subagents from an inline JS DSL with phase()/log()/agent()/parallel()/pipeline(), structured outputs, and optional background execution";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Only call workflow when the user says 'ultracode' or explicitly requests a workflow run; otherwise solve in the main session.",
  "Use workflow when a task needs several subagents with phase dependencies, explicit handover, dynamic fan-out/fan-in, or verify-then-synthesize pipelines; keep single small delegations in the main session.",
  "In workflow scripts, agent() never throws — always check `.ok` on its result before using `.output`/`.structured`.",
  "Use runtime phase(title) for live progress; meta.phases is optional documentation, not a required up-front declaration.",
  "There is no workflow budget API; control scope with agent count, clear prompts, schemas, and concise logs.",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  const logs = recentWorkflowLogs(
    details,
    details.status === "completed" ? 5 : 8,
  );
  if (logs.length > 0) {
    lines.push("", "Recent logs:");
    for (const log of logs) lines.push(`- ${log.replace(/\n/g, " ")}`);
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

/** Builds the follow-up user message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  return `[Background workflow ${options.runId} ${options.status}]\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model where progress and artifacts appear. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    "You'll receive a follow-up message when it finishes; /workflows shows progress.",
  ].join("\n");
}
