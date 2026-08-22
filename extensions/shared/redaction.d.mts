export const REDACTION_RULES_VERSION: 2;
export const REDACTION_MARKERS: Readonly<{
  header: string;
  cookie: string;
  secretField: string;
  privateKey: string;
  token: string;
  credentialUrl: string;
}>;
export function emptyRedactionCounts(): Record<string, number>;
export function mergeRedactionCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): Record<string, number>;
export function redactString(input: string): {
  value: string;
  counts: Record<string, number>;
};
export function isSecretFieldName(key: string): boolean;
export function redactJson(
  input: unknown,
  options?: { secretNamedValues?: boolean },
): { value: unknown; counts: Record<string, number> };
export function encodedStringBytes(value: string): number;
