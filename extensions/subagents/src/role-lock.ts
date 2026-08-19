import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RoleLeaseHandle } from "./domain.ts";

interface RoleLockRecord {
  readonly version: 1;
  readonly role: string;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: number;
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

function normalizedRole(input: string): string {
  const role = input.trim().replace(/\s+/g, "-").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(role) || role.length > 80) {
    throw new Error(`Invalid subagent role name: "${input}".`);
  }
  return role;
}

function encodedRoleFileName(role: string): string {
  return Buffer.from(role, "utf8").toString("base64url");
}

export function getRoleLocksDir(agentDir = defaultAgentDir()): string {
  return path.join(agentDir, "multi-agent", "role-locks");
}

function lockPath(role: string, agentDir?: string): string {
  return path.join(
    getRoleLocksDir(agentDir),
    `${encodedRoleFileName(role)}.lock`,
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): RoleLockRecord | undefined {
  try {
    const value = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as Partial<RoleLockRecord>;
    if (
      value.version !== 1 ||
      typeof value.role !== "string" ||
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.hostname !== "string" ||
      typeof value.acquiredAt !== "number"
    ) {
      return undefined;
    }
    return value as RoleLockRecord;
  } catch {
    return undefined;
  }
}

/**
 * Acquire a machine-local, process-safe role lock. A lock owned by a dead PID
 * is reclaimed. The returned release is token-checked and idempotent.
 */
export function acquireRoleLock(
  inputRole: string,
  agentDir?: string,
): RoleLeaseHandle {
  const role = normalizedRole(inputRole);
  const dir = getRoleLocksDir(agentDir);
  const file = lockPath(role, agentDir);
  fs.mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomUUID();
    const record: RoleLockRecord = {
      version: 1,
      role,
      token,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    };
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      } finally {
        fs.closeSync(fd);
      }

      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          const current = readLock(file);
          if (current?.token !== token) return;
          try {
            fs.unlinkSync(file);
          } catch {
            // Best-effort release; token checking prevents deleting a successor.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readLock(file);
      const sameMachine = owner?.hostname === os.hostname();
      let stale = owner ? sameMachine && !processIsAlive(owner.pid) : false;
      if (!owner) {
        try {
          // A process can die between exclusive creation and writing JSON.
          stale = Date.now() - fs.statSync(file).mtimeMs > 30_000;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
      }
      if (stale) {
        try {
          fs.unlinkSync(file);
          continue;
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT")
            continue;
        }
      }
      const detail = owner
        ? ` by PID ${owner.pid}${sameMachine ? "" : ` on ${owner.hostname}`}`
        : "";
      throw new Error(`Subagent role "${role}" is already active${detail}.`);
    }
  }

  throw new Error(`Could not acquire subagent role lock for "${role}".`);
}
