import { OBSERVABILITY_LIMITS } from "../../extensions/shared/observability/normalize.mjs";

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const BUILD_VERSION = "0.3.0-d3";

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

export const READ_LIMITS = Object.freeze({
  runsDefault: 50,
  runsMaximum: 200,
  eventsDefault: 200,
  eventsMaximum: 500,
  eventPageBytes: 1024 * 1024,
  agentsPerRun: 500,
  opaqueIdBytes: 256,
  queryParameters: 8,
  queryBytes: 4 * 1024,
  responseBytes: 4 * 1024 * 1024,
  staticAssetBytes: 512 * 1024,
  staticTotalBytes: 1024 * 1024,
  pollIntervalMs: 2_000,
  clientEventRows: 2_000,
});
