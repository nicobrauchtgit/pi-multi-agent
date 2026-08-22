import {
  companionHome,
  observabilityPaths,
  resolveAgentDir,
} from "../../extensions/shared/observability/home.mjs";

export { companionHome, resolveAgentDir };

/** Backward-compatible companion name for the shared protected path inventory. */
export function homePaths(agentDir = resolveAgentDir()) {
  return observabilityPaths(agentDir);
}
