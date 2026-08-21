export function resolveAgentDir(configured?: string): string;
export function companionHome(agentDir?: string): string;
export function homePaths(agentDir?: string): Readonly<{
  agentDir: string;
  multiAgentDir: string;
  root: string;
  spoolDir: string;
  logsDir: string;
  lock: string;
  state: string;
  ingestToken: string;
  readToken: string;
  metrics: string;
  database: string;
  wal: string;
  shm: string;
  log: string;
}>;
