import * as fs from "node:fs";
import {
  DEFAULT_OBSERVABILITY_CONFIG,
  normalizePolicyConfig,
} from "../../extensions/shared/observability/policy.mjs";
import { SecurityError, secureFile } from "./fsguard.mjs";
import { readJson, writeAtomicJson } from "./state.mjs";

const CONFIG_MAX_BYTES = 256 * 1024;

function invalidConfig(file, reason = "config-invalid") {
  const error = new SecurityError(reason, file);
  error.code = reason;
  return error;
}

export function ensureDefaultConfig(file) {
  try {
    secureFile(file);
    return;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "file-missing") {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        // Fall through to the exclusive default write below.
      } else if (error instanceof SecurityError) {
        throw error;
      }
    }
  }
  try {
    writeAtomicJson(file, DEFAULT_OBSERVABILITY_CONFIG);
  } catch (error) {
    // Another trusted starter may have installed the same protected file.
    try {
      secureFile(file);
      return;
    } catch {
      throw error;
    }
  }
}

export function loadConfig(file) {
  try {
    secureFile(file);
    return normalizePolicyConfig(readJson(file, CONFIG_MAX_BYTES));
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw invalidConfig(file);
  }
}

/** Reload between batches; invalid replacement policy fails closed for ingest. */
export function createConfigLoader(file) {
  ensureDefaultConfig(file);
  let cached;
  let identity;
  return {
    current() {
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        throw invalidConfig(file, "config-unavailable");
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw invalidConfig(file, "config-invalid-type");
      }
      const nextIdentity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (!cached || identity !== nextIdentity) {
        cached = loadConfig(file);
        identity = nextIdentity;
      }
      return cached;
    },
  };
}
