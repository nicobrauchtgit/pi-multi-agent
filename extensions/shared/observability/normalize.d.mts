export type NormalizedContentMode = "rich" | "metadata" | "disabled";
export type NormalizedObservabilityEvent = Readonly<{
  v: 1;
  eventId: `event_${string}`;
  kind: string;
  schemaVersion: 1;
  producer: Readonly<{
    id: `producer_${string}`;
    seq: number;
    kind: "pi";
  }>;
  occurredAt: number;
  ids: Readonly<Record<string, string>>;
  project?: Readonly<{ id: string; root: string }>;
  payload: Record<string, unknown>;
  capture: Readonly<{
    contentMode: NormalizedContentMode;
    truncated: boolean;
    truncatedFields?: readonly string[];
    fieldBytes?: Readonly<
      Record<string, { readonly original: number; readonly stored: number }>
    >;
  }>;
}>;

export interface ObservabilityLimits {
  readonly batchBytes: number;
  readonly batchEvents: number;
  readonly storedEventBytes: number;
  readonly envelopeBytes: number;
  readonly contentBytes: number;
  readonly promptBytes: number;
  readonly assistantBytes: number;
  readonly toolArgumentsBytes: number;
  readonly toolResultBytes: number;
  readonly structuredBytes: number;
  readonly metadataStringBytes: number;
  readonly eventIdBytes: number;
  readonly kindBytes: number;
  readonly keyBytes: number;
  readonly depth: number;
  readonly nodes: number;
  readonly objectKeys: number;
  readonly arrayItems: number;
}

export const OBSERVABILITY_LIMITS: ObservabilityLimits;
export const KNOWN_OBSERVABILITY_KINDS: readonly string[];
export class SharedNormalizationError extends Error {
  readonly code: string;
}
export function canonicalize<T>(value: T): T;
export function canonicalJson(value: unknown): string;
export function boundEncodedString(
  value: string,
  maximum: number,
): {
  value: string;
  original: number;
  stored: number;
  truncated: boolean;
};
export function hasLoneSurrogate(value: string): boolean;
export function validateJsonValue(
  value: unknown,
  limits?: ObservabilityLimits,
): number;
export function contentClassification(
  kind: string,
  path: string,
  key: string,
  limits?: ObservabilityLimits,
): { content: boolean; cap: number; omit?: boolean };
export function scanAndBoundMetadata(
  value: string,
  maximum: number,
  counts: Record<string, number>,
): { value: string; original: number; stored: number; truncated: boolean };
export function normalizePayload(
  payload: Record<string, unknown>,
  kind: string,
  contentMode: NormalizedContentMode,
  counts?: Record<string, number>,
  limits?: ObservabilityLimits,
): {
  payload: unknown;
  truncatedFields: string[];
  fieldBytes: Record<string, { original: number; stored: number }>;
};
export function normalizeProducerTruncation(
  capture: unknown,
  counts: Record<string, number>,
  limits?: ObservabilityLimits,
): unknown;
export function sumStringBytes(value: unknown): number;
export function normalizeProducerEnvelope(
  input: unknown,
  options?: {
    contentMode?: NormalizedContentMode;
    limits?: ObservabilityLimits;
  },
): Readonly<{
  event: NormalizedObservabilityEvent;
  serialized: string;
  bytes: number;
  redactionCounts: Record<string, number>;
}>;
export function isKnownObservabilityKind(kind: string): boolean;
