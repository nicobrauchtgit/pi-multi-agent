export {
  companionHome,
  resolveAgentDir,
} from "../../extensions/shared/observability/home.mjs";
export type { ObservabilityPaths } from "../../extensions/shared/observability/home.mjs";
export function homePaths(
  agentDir?: string,
): import("../../extensions/shared/observability/home.mjs").ObservabilityPaths;
