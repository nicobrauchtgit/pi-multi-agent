import type { ObservabilityPaths } from "../../shared/observability/home.mjs";
import {
  DEFAULT_OBSERVABILITY_CONFIG,
  normalizePolicyConfig,
  type ObservabilityPolicyConfig,
} from "../../shared/observability/policy.mjs";
import {
  ensureProducerTree,
  readProtectedJson,
  secureFile,
  writeAtomicProtectedJson,
} from "./protected-fs.ts";

export interface ProducerConfigResult {
  readonly config: ObservabilityPolicyConfig;
  readonly valid: boolean;
  readonly reason?: string;
}

function failClosedConfig(): ObservabilityPolicyConfig {
  return normalizePolicyConfig({
    ...DEFAULT_OBSERVABILITY_CONFIG,
    capture: "off",
    autostart: false,
  });
}

/** Load once before hooks. Corruption/security failure disables all producer I/O. */
export function loadProducerConfig(
  paths: ObservabilityPaths,
): ProducerConfigResult {
  try {
    ensureProducerTree(paths);
    if (!secureFile(paths.config, true)) {
      writeAtomicProtectedJson(paths.config, DEFAULT_OBSERVABILITY_CONFIG);
    }
    return {
      config: normalizePolicyConfig(
        readProtectedJson(paths.config, 256 * 1024),
      ),
      valid: true,
    };
  } catch (error) {
    return {
      config: failClosedConfig(),
      valid: false,
      reason:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "config-invalid",
    };
  }
}
