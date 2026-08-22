import * as os from "node:os";
import * as path from "node:path";

/** Resolve Pi's agent directory without importing the Pi extension runtime. */
export function resolveAgentDir(configured = process.env.PI_CODING_AGENT_DIR) {
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

export function companionHome(agentDir = resolveAgentDir()) {
  return path.join(agentDir, "multi-agent", "observability");
}

/** One canonical inventory for producer, daemon, and child path protection. */
export function observabilityPaths(agentDir = resolveAgentDir()) {
  const root = companionHome(agentDir);
  const database = path.join(root, "observability.sqlite3");
  return Object.freeze({
    agentDir,
    multiAgentDir: path.join(agentDir, "multi-agent"),
    root,
    spoolDir: path.join(root, "spool"),
    quarantineDir: path.join(root, "spool", "quarantine"),
    logsDir: path.join(root, "logs"),
    exportDir: path.join(root, "export"),
    lock: path.join(root, "daemon.lock"),
    state: path.join(root, "daemon.json"),
    config: path.join(root, "config.json"),
    spoolState: path.join(root, "spool-state.json"),
    ingestToken: path.join(root, "ingest.token"),
    readToken: path.join(root, "read.token"),
    metrics: path.join(root, "daemon-metrics.json"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
    log: path.join(root, "logs", "daemon.log"),
    rolesDir: path.join(agentDir, "multi-agent", "roles"),
    workflowsDir: path.join(agentDir, "workflows"),
    runArtifactsDir: path.join(agentDir, "multi-agent", "runs"),
  });
}
