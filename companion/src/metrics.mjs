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
  projectDisabled: 0,
  policyDowngrades: 0,
  producerGaps: 0,
  spoolSegmentsReplayed: 0,
  spoolRecordsReplayed: 0,
  spoolPartialTails: 0,
  spoolMalformed: 0,
  rejectedByReason: {},
  redactionByClass: {},
});

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const COUNT_KEY = /^[a-zA-Z0-9_.-]{1,80}$/;
const MAX_COUNT_KEYS = 128;

function boundedCounts(value) {
  const output = {};
  if (!value || typeof value !== "object") return output;
  for (const [key, count] of Object.entries(value).slice(0, MAX_COUNT_KEYS)) {
    if (COUNT_KEY.test(key)) output[key] = nonnegativeInteger(count);
  }
  return output;
}

function incrementBoundedCount(target, untrustedKey, amount = 1) {
  let key =
    typeof untrustedKey === "string" && COUNT_KEY.test(untrustedKey)
      ? untrustedKey
      : "invalid";
  if (
    !Object.hasOwn(target, key) &&
    Object.keys(target).length >= MAX_COUNT_KEYS - 1
  ) {
    key = "other";
  }
  target[key] =
    nonnegativeInteger(target[key]) + Math.max(0, Math.floor(amount));
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
      projectDisabled: nonnegativeInteger(value.projectDisabled),
      policyDowngrades: nonnegativeInteger(value.policyDowngrades),
      producerGaps: nonnegativeInteger(value.producerGaps),
      spoolSegmentsReplayed: nonnegativeInteger(value.spoolSegmentsReplayed),
      spoolRecordsReplayed: nonnegativeInteger(value.spoolRecordsReplayed),
      spoolPartialTails: nonnegativeInteger(value.spoolPartialTails),
      spoolMalformed: nonnegativeInteger(value.spoolMalformed),
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
    set(key, value) {
      state[key] = nonnegativeInteger(value);
    },
    reject(reason) {
      increment("rejected");
      incrementBoundedCount(state.rejectedByReason, reason);
    },
    addRedactions(counts) {
      for (const [rule, count] of Object.entries(counts)) {
        if (count > 0) {
          incrementBoundedCount(state.redactionByClass, rule, count);
        }
      }
    },
    flush() {
      writeAtomicJson(file, state);
    },
  };
}
