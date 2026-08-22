import { OBSERVABILITY_LIMITS } from "../../extensions/shared/observability/normalize.mjs";

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const BUILD_VERSION = "0.2.0-d2";

export const EXIT = Object.freeze({
  OK: 0,
  UNAVAILABLE: 69,
  SECURITY: 71,
  LOCKED: 72,
  MIGRATION: 73,
  CORRUPT: 74,
  USAGE: 64,
  SOFTWARE: 70,
});

export const LIMITS = Object.freeze({
  ...OBSERVABILITY_LIMITS,
  inflightRequests: 16,
});
