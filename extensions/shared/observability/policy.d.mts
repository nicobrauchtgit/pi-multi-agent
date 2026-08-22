export type ContentMode = "rich" | "metadata" | "disabled";
export type CaptureSetting = "off" | "metadata" | "rich";

export interface PolicyDefaults {
  readonly enabled: boolean;
  readonly contentMode: ContentMode;
  readonly excludePaths: readonly string[];
  readonly retentionDays: number;
  readonly maxDatabaseBytes: number;
  readonly maxSpoolBytes: number;
}

export interface ProjectPolicyEntry {
  readonly root: string;
  readonly enabled?: boolean;
  readonly contentMode?: ContentMode;
  readonly excludePaths?: readonly string[];
}

export interface ObservabilityPolicyConfig {
  readonly version: 1;
  readonly capture: CaptureSetting;
  readonly autostart: boolean;
  readonly defaults: PolicyDefaults;
  readonly projects: readonly ProjectPolicyEntry[];
  readonly moshiPaths: readonly string[];
}

export interface ResolvedProjectPolicy extends PolicyDefaults {
  readonly root?: string;
  readonly policyRoot?: string;
  readonly policySource: "project" | "defaults";
}

export const DEFAULT_SECRET_EXCLUDE_PATHS: readonly string[];
export const DEFAULT_OBSERVABILITY_CONFIG: Readonly<Record<string, unknown>>;
export function canonicalizePath(value: string, cwd?: string): string;
export function pathContains(root: string, candidate: string): boolean;
export function normalizePolicyConfig(
  value: unknown,
): ObservabilityPolicyConfig;
export function defaultPolicyConfig(): ObservabilityPolicyConfig;
export function minimumContentMode(...modes: ContentMode[]): ContentMode;
export function resolveProjectPolicy(
  config: ObservabilityPolicyConfig,
  projectRoot?: string,
): ResolvedProjectPolicy;
export function matchesExcludePath(
  relativePath: string,
  patterns: readonly string[],
): boolean;
export function classifyContentPath(options: {
  value: string;
  cwd?: string;
  projectRoot?: string;
  excludePaths?: readonly string[];
  protectedRoots?: readonly string[];
  moshiPaths?: readonly string[];
}): Readonly<{
  excluded: boolean;
  classification: "unresolved" | "protected" | "secret-path" | "ordinary";
}>;
