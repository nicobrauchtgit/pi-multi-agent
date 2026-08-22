export interface ObservabilityPaths {
  readonly agentDir: string;
  readonly multiAgentDir: string;
  readonly root: string;
  readonly spoolDir: string;
  readonly quarantineDir: string;
  readonly logsDir: string;
  readonly exportDir: string;
  readonly lock: string;
  readonly state: string;
  readonly config: string;
  readonly spoolState: string;
  readonly ingestToken: string;
  readonly readToken: string;
  readonly metrics: string;
  readonly database: string;
  readonly wal: string;
  readonly shm: string;
  readonly log: string;
  readonly rolesDir: string;
  readonly workflowsDir: string;
  readonly runArtifactsDir: string;
}

export function resolveAgentDir(configured?: string): string;
export function companionHome(agentDir?: string): string;
export function observabilityPaths(agentDir?: string): ObservabilityPaths;
