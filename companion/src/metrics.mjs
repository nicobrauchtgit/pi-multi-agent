import * as fs from "node:fs";
import { readJson, writeAtomicJson } from "./state.mjs";

const EMPTY = Object.freeze({
  version: 1,
  accepted: 0,
  duplicate: 0,
  conflict: 0,
  rejected: 0,
  batches: 0,
  projectIdMismatch: 0,
  truncations: 0,
  rejectedByReason: {},
  redactionByClass: {},
});

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedCounts(value) {
  const output = {};
  if (!value || typeof value !== "object") return output;
  for (const [key, count] of Object.entries(value).slice(0, 128)) {
    if (/^[a-zA-Z0-9_.-]{1,80}$/.test(key))
      output[key] = nonnegativeInteger(count);
  }
  return output;
}

export function loadMetrics(file) {
  try {
    const value = readJson(file, 64 * 1024);
    return {
      version: 1,
      accepted: nonnegativeInteger(value.accepted),
      duplicate: nonnegativeInteger(value.duplicate),
      conflict: nonnegativeInteger(value.conflict),
      rejected: nonnegativeInteger(value.rejected),
      batches: nonnegativeInteger(value.batches),
      projectIdMismatch: nonnegativeInteger(value.projectIdMismatch),
      truncations: nonnegativeInteger(value.truncations),
      rejectedByReason: boundedCounts(value.rejectedByReason),
      redactionByClass: boundedCounts(value.redactionByClass),
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") {
      // Invalid counter state is discarded; it never contains event data.
    }
    return structuredClone(EMPTY);
  }
}

export function createMetrics(file) {
  const state = loadMetrics(file);
  const increment = (key, amount = 1) => {
    state[key] =
      nonnegativeInteger(state[key]) + Math.max(0, Math.floor(amount));
  };
  return {
    state,
    increment,
    reject(reason) {
      increment("rejected");
      state.rejectedByReason[reason] =
        (state.rejectedByReason[reason] ?? 0) + 1;
    },
    addRedactions(counts) {
      for (const [rule, count] of Object.entries(counts)) {
        if (count > 0 && /^[a-zA-Z0-9_.-]{1,80}$/.test(rule)) {
          state.redactionByClass[rule] =
            (state.redactionByClass[rule] ?? 0) + Math.floor(count);
        }
      }
    },
    flush() {
      writeAtomicJson(file, state);
    },
  };
}

export function metricsFileExists(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}
