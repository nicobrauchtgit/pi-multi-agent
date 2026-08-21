export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const BUILD_VERSION = "0.1.0-d1";

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
  batchBytes: 2 * 1024 * 1024,
  batchEvents: 128,
  storedEventBytes: 512 * 1024,
  envelopeBytes: 128 * 1024,
  contentBytes: 256 * 1024,
  promptBytes: 64 * 1024,
  assistantBytes: 128 * 1024,
  toolArgumentsBytes: 64 * 1024,
  toolResultBytes: 128 * 1024,
  structuredBytes: 256 * 1024,
  metadataStringBytes: 4 * 1024,
  eventIdBytes: 200,
  kindBytes: 200,
  keyBytes: 256,
  depth: 32,
  nodes: 20_000,
  objectKeys: 256,
  arrayItems: 4_096,
  inflightRequests: 16,
});
