export type AgentHarness = "pi" | "claude" | "codex";
export type RoutedTaskKind = "planning" | "implementation" | "review";
type HarnessRoute = readonly [AgentHarness, ...AgentHarness[]];

/**
 * Edit this map to change the preferred harness for each kind of work.
 * Each review entry produces one independent reviewer.
 */
export const TASK_HARNESS_MAP = Object.freeze({
  planning: Object.freeze(["claude"]),
  implementation: Object.freeze(["codex"]),
  review: Object.freeze(["claude", "codex"]),
} as const satisfies Readonly<Record<RoutedTaskKind, HarnessRoute>>);

const HARNESS_LABELS = {
  pi: "Pi",
  claude: "Claude",
  codex: "Codex",
} as const satisfies Readonly<Record<AgentHarness, string>>;

const COUNT_LABELS = ["zero", "one", "two", "three"] as const;

const ROUTES = Object.entries(TASK_HARNESS_MAP)
  .map(([task, harnesses]) => `${task} -> ${harnesses.join(" + ")}`)
  .join("; ");

const reviewHarnesses: HarnessRoute = TASK_HARNESS_MAP.review;
const reviewCount =
  COUNT_LABELS[reviewHarnesses.length] ?? String(reviewHarnesses.length);
const reviewAssignments = reviewHarnesses
  .map((harness) => `one ${HARNESS_LABELS[harness]} subagent`)
  .join(", ");

export const TASK_HARNESS_PROMPT =
  `Task-to-harness routes: ${ROUTES}. ` +
  `Use the planning and implementation routes as defaults unless the user asks for another harness or the task clearly needs different tools. Every review must use ${reviewCount} independent reviewers: ${reviewAssignments}. Reconcile all reviews before deciding the outcome. Choose each model separately within its selected harness.`;
