export interface HandoffUsage {
  readonly tokens?: number;
  readonly contextWindow?: number;
}

export interface HandoffPolicy {
  readonly enabled: boolean;
  readonly tokenThreshold: number;
  readonly ratioThreshold: number;
  readonly reserveTokens: number;
}

export interface HandoffDecision {
  readonly shouldHandoff: boolean;
  readonly reason?: string;
}

export const DEFAULT_HANDOFF_POLICY: HandoffPolicy = Object.freeze({
  enabled: true,
  tokenThreshold: 120_000,
  ratioThreshold: 0.8,
  reserveTokens: 16_000,
});

export function handoffDecision(
  usage: HandoffUsage,
  policy: HandoffPolicy = DEFAULT_HANDOFF_POLICY,
): HandoffDecision {
  if (!policy.enabled) return { shouldHandoff: false };
  const tokens = usage.tokens;
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return { shouldHandoff: false };
  }
  const contextWindow = usage.contextWindow;
  if (
    contextWindow !== undefined &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0
  ) {
    const cutoff = Math.max(
      0,
      Math.min(
        policy.tokenThreshold,
        Math.floor(contextWindow * policy.ratioThreshold) -
          policy.reserveTokens,
      ),
    );
    if (tokens >= cutoff) {
      return {
        shouldHandoff: true,
        reason: `context usage ${tokens}/${contextWindow} reached handoff cutoff ${cutoff}`,
      };
    }
    return { shouldHandoff: false };
  }
  if (tokens >= policy.tokenThreshold) {
    return {
      shouldHandoff: true,
      reason: `context usage ${tokens} reached handoff threshold ${policy.tokenThreshold}`,
    };
  }
  return { shouldHandoff: false };
}
