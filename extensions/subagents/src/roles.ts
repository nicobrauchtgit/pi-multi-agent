import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isJsonSchema } from "../../shared/json-schema.ts";
import type {
  BackendName,
  ReasoningEffort,
  SubagentSnapshot,
} from "./domain.ts";

export const ROLE_RECORD_VERSION = 1;
export const ROLE_STATUSES = [
  "idle",
  "running",
  "done",
  "error",
  "missing",
] as const;
export type PersistentSubagentStatus = (typeof ROLE_STATUSES)[number];

export interface PersistentSubagentRecord {
  readonly version: 1;
  readonly role: string;
  readonly title: string;
  readonly backend: BackendName;
  readonly cwd: string;
  readonly model?: string;
  readonly modelLabel?: string;
  readonly reasoningEffort?: ReasoningEffort;
  /** Structured-output contract restored with the native session. */
  readonly schema?: unknown;
  /** Read-time diagnostic; invalid persisted contracts must not be dropped. */
  readonly schemaError?: string;
  readonly sessionFilePath?: string;
  readonly nativeSessionId?: string;
  readonly lastSubagentId?: string;
  readonly status: PersistentSubagentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly parentPiSessionId?: string;
}

export type RoleUpsert = Pick<
  PersistentSubagentRecord,
  "role" | "title" | "backend" | "cwd"
> & {
  /** Fresh native session: do not inherit an older role's native locator. */
  readonly resetNativeLocator?: boolean;
  /** Explicitly remove a stale persisted structured-output contract. */
  readonly clearSchema?: boolean;
} & Partial<
    Pick<
      PersistentSubagentRecord,
      | "model"
      | "modelLabel"
      | "reasoningEffort"
      | "schema"
      | "sessionFilePath"
      | "nativeSessionId"
      | "lastSubagentId"
      | "status"
      | "parentPiSessionId"
    >
  >;

export type RoleUpdate = Partial<Omit<RoleUpsert, "role">>;

const ROLE_NAME_MAX_LENGTH = 80;

export function normalizeRoleName(input: string): string {
  return input.trim().replace(/\s+/g, "-").toLowerCase();
}

export function validateRoleName(role: string): string | undefined {
  if (!role) return "Role name is required.";
  if (role.length > ROLE_NAME_MAX_LENGTH) {
    return `Role name must be ${ROLE_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (/[\u0000-\u001f\u007f/\\]/.test(role)) {
    return "Role name must not contain slashes or control characters.";
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(role)) {
    return "Role name must start with a letter or digit and contain only letters, digits, '.', '_', or '-'.";
  }
  return undefined;
}

export function normalizeAndValidateRoleName(input: string): string {
  const role = normalizeRoleName(input);
  const error = validateRoleName(role);
  if (error) throw new Error(error);
  return role;
}

function defaultAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  return configured === "~"
    ? os.homedir()
    : configured.startsWith("~/")
      ? path.join(os.homedir(), configured.slice(2))
      : path.resolve(configured);
}

export function getRolesDir(agentDir = defaultAgentDir()): string {
  return path.join(agentDir, "multi-agent", "roles");
}

export function encodeRoleFileName(role: string): string {
  return `${Buffer.from(role, "utf8").toString("base64url")}.json`;
}

function rolePath(role: string, agentDir?: string): string {
  return path.join(getRolesDir(agentDir), encodeRoleFileName(role));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBackend(value: unknown): value is BackendName {
  return value === "pi" || value === "claude" || value === "codex";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function isStatus(value: unknown): value is PersistentSubagentStatus {
  return ROLE_STATUSES.includes(value as PersistentSubagentStatus);
}

function parseRoleRecord(value: unknown): PersistentSubagentRecord | undefined {
  if (!isObject(value)) return undefined;
  if (value.version !== 1) return undefined;
  const role = optionalString(value.role);
  if (!role || validateRoleName(role)) return undefined;
  const title = optionalString(value.title);
  const backend = value.backend;
  const cwd = optionalString(value.cwd);
  const status = value.status;
  const createdAt =
    typeof value.createdAt === "number" ? value.createdAt : undefined;
  const updatedAt =
    typeof value.updatedAt === "number" ? value.updatedAt : undefined;
  if (
    !title ||
    !isBackend(backend) ||
    !cwd ||
    !isStatus(status) ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  const hasPersistedSchema =
    Object.hasOwn(value, "schema") && value.schema !== undefined;
  const validSchema = hasPersistedSchema && isJsonSchema(value.schema);
  const schemaError =
    hasPersistedSchema && !validSchema
      ? "Persisted structured-output schema is invalid or no longer supported."
      : undefined;
  return {
    version: 1,
    role,
    title,
    backend,
    cwd,
    model: optionalString(value.model),
    modelLabel: optionalString(value.modelLabel),
    reasoningEffort: isReasoningEffort(value.reasoningEffort)
      ? value.reasoningEffort
      : undefined,
    schema: validSchema ? value.schema : undefined,
    schemaError,
    sessionFilePath: optionalString(value.sessionFilePath),
    nativeSessionId: optionalString(value.nativeSessionId),
    lastSubagentId: optionalString(value.lastSubagentId),
    status: schemaError ? "missing" : status,
    createdAt,
    updatedAt,
    parentPiSessionId: optionalString(value.parentPiSessionId),
  };
}

function readRole(
  role: string,
  agentDir?: string,
): PersistentSubagentRecord | undefined {
  try {
    const raw = fs.readFileSync(rolePath(role, agentDir), "utf8");
    return parseRoleRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function writeRole(record: PersistentSubagentRecord, agentDir?: string): void {
  const dir = getRolesDir(agentDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = rolePath(record.role, agentDir);
  const tmp = path.join(
    dir,
    `.${encodeRoleFileName(record.role)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function getRole(
  inputRole: string,
  agentDir?: string,
): PersistentSubagentRecord | undefined {
  const role = normalizeAndValidateRoleName(inputRole);
  return readRole(role, agentDir);
}

export function listRoles(agentDir?: string): PersistentSubagentRecord[] {
  const dir = getRolesDir(agentDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: PersistentSubagentRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = parseRoleRecord(
        JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")),
      );
      if (parsed) records.push(parsed);
    } catch {
      // Ignore corrupt/unreadable role files. One bad role must not hide others.
    }
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return records;
}

export function upsertRole(
  input: RoleUpsert,
  agentDir?: string,
): PersistentSubagentRecord {
  const role = normalizeAndValidateRoleName(input.role);
  if (input.schema !== undefined && !isJsonSchema(input.schema)) {
    throw new Error("Cannot persist an invalid structured-output schema.");
  }
  const existing = readRole(role, agentDir);
  const now = Date.now();
  const record: PersistentSubagentRecord = {
    version: 1,
    role,
    title: input.title,
    backend: input.backend,
    cwd: input.cwd,
    model: input.model ?? existing?.model,
    modelLabel: input.modelLabel ?? existing?.modelLabel,
    reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
    schema:
      input.resetNativeLocator || input.clearSchema
        ? input.schema
        : (input.schema ?? existing?.schema),
    sessionFilePath: input.resetNativeLocator
      ? input.sessionFilePath
      : (input.sessionFilePath ?? existing?.sessionFilePath),
    nativeSessionId: input.resetNativeLocator
      ? input.nativeSessionId
      : (input.nativeSessionId ?? existing?.nativeSessionId),
    lastSubagentId: input.lastSubagentId ?? existing?.lastSubagentId,
    status: input.status ?? existing?.status ?? "idle",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    parentPiSessionId: input.parentPiSessionId ?? existing?.parentPiSessionId,
  };
  writeRole(record, agentDir);
  return record;
}

export function updateRole(
  inputRole: string,
  update: RoleUpdate,
  agentDir?: string,
): PersistentSubagentRecord | undefined {
  const role = normalizeAndValidateRoleName(inputRole);
  const existing = readRole(role, agentDir);
  if (!existing) return undefined;
  return upsertRole({ ...existing, ...update, role }, agentDir);
}

export function forgetRole(inputRole: string, agentDir?: string): boolean {
  const role = normalizeAndValidateRoleName(inputRole);
  try {
    fs.unlinkSync(rolePath(role, agentDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function roleUpsertFromSnapshot(
  snap: SubagentSnapshot,
  extras: Partial<
    Pick<
      RoleUpsert,
      "model" | "reasoningEffort" | "schema" | "parentPiSessionId"
    >
  > = {},
): RoleUpsert | undefined {
  if (!snap.role) return undefined;
  return {
    role: snap.role,
    title: snap.title,
    backend: snap.backend,
    cwd: snap.cwd,
    model: extras.model,
    modelLabel: snap.meta.modelLabel,
    reasoningEffort: extras.reasoningEffort,
    schema: extras.schema,
    sessionFilePath: snap.meta.sessionFilePath,
    nativeSessionId: snap.meta.nativeSessionId,
    lastSubagentId: snap.id,
    status: snap.status,
    parentPiSessionId: extras.parentPiSessionId,
  };
}
