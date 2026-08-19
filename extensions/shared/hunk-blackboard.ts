/**
 * Hunk-as-shared-blackboard helper (plain TS, no Effect).
 *
 * Agents coordinate through a live Hunk review session per repo: they read
 * entries other agents posted and write their own findings/claims/handoffs as
 * Hunk comments (attributed with --author). Hunk's daemon owns the session;
 * comments are the read/write board (see the bundled `hunk-review` skill).
 *
 * We auto-provision a session headlessly: if none is registered for the repo,
 * we launch `hunk diff` inside a PTY (`script`) so it registers with the
 * daemon without a human opening the TUI. Everything degrades gracefully to
 * null when hunk is missing, the dir is not a git repo, or provisioning fails.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface BlackboardInfo {
  /** Git repo root the Hunk session is loaded on (what `--repo` matches). */
  readonly repoRoot: string;
  readonly sessionId: string;
}

const SESSION_POLL_ATTEMPTS = 16;
const SESSION_POLL_INTERVAL_MS = 500;

const sessions = new Map<string, BlackboardInfo>();
const pending = new Map<string, Promise<BlackboardInfo | null>>();
const ptyChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hunkAvailable(): Promise<boolean> {
  try {
    await execFileP("hunk", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the git repo root for a cwd, or null when not inside a repo. */
async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 5_000 },
    );
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Read the live session id for a repo root, or null when none is registered. */
async function getSessionId(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "hunk",
      ["session", "get", "--repo", repoRoot, "--json"],
      { timeout: 5_000 },
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const direct = parsed.sessionId;
    const nested = (parsed.session as Record<string, unknown> | undefined)
      ?.sessionId;
    const id = typeof direct === "string" ? direct : nested;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Launch `hunk diff` in a detached PTY so the daemon registers a session. */
function launchSession(repoRoot: string): void {
  installExitHook();
  try {
    // BSD/macOS `script -q <file> <command...>` runs the command in a PTY.
    const child = spawn("script", ["-q", "/dev/null", "hunk", "diff"], {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", () => ptyChildren.delete(child));
    child.on("exit", () => ptyChildren.delete(child));
    ptyChildren.add(child);
  } catch {
    // Provisioning is best-effort; ensureBlackboard resolves null on failure.
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const kill = () => disposeBlackboards();
  process.once("exit", kill);
  process.once("SIGINT", kill);
  process.once("SIGTERM", kill);
}

/**
 * Ensure a live Hunk blackboard session for `cwd`'s repo. Reuses an existing
 * session, otherwise auto-provisions one. Cached and de-duplicated per repo
 * root. Returns null when unavailable (hunk missing / not a git repo / timeout).
 */
export async function ensureBlackboard(
  cwd: string,
  options: { refresh?: boolean } = {},
): Promise<BlackboardInfo | null> {
  const repoRoot = await gitRoot(cwd);
  if (!repoRoot) return null;
  const cached = sessions.get(repoRoot);
  if (cached && !options.refresh) return cached;
  if (cached && options.refresh) {
    const liveSessionId = await getSessionId(repoRoot);
    if (liveSessionId === cached.sessionId) return cached;
    sessions.delete(repoRoot);
    if (liveSessionId) {
      const refreshed: BlackboardInfo = {
        repoRoot,
        sessionId: liveSessionId,
      };
      sessions.set(repoRoot, refreshed);
      return refreshed;
    }
  }
  const inflight = pending.get(repoRoot);
  if (inflight) return inflight;

  const work = (async (): Promise<BlackboardInfo | null> => {
    if (!(await hunkAvailable())) return null;
    let sessionId = await getSessionId(repoRoot);
    if (!sessionId) {
      launchSession(repoRoot);
      for (let i = 0; i < SESSION_POLL_ATTEMPTS && !sessionId; i++) {
        await delay(SESSION_POLL_INTERVAL_MS);
        sessionId = await getSessionId(repoRoot);
      }
    }
    if (!sessionId) return null;
    const info: BlackboardInfo = { repoRoot, sessionId };
    sessions.set(repoRoot, info);
    return info;
  })();

  pending.set(repoRoot, work);
  try {
    return await work;
  } finally {
    pending.delete(repoRoot);
  }
}

/** Child-prompt block teaching agents to coordinate via the Hunk blackboard. */
export function blackboardPromptBlock(info: BlackboardInfo): string {
  const repo = info.repoRoot;
  return [
    "## Shared blackboard (Hunk)",
    "",
    "You share a live Hunk review session with the other agents working in this repo. Treat it as a coordination blackboard: READ what others posted before you act, and POST your own claims, findings, handoffs, and blockers so others can see them.",
    "",
    "Read the board:",
    "```sh",
    `hunk session comment list --repo ${repo} --json`,
    `hunk session review --repo ${repo} --include-notes --json   # entries in diff context`,
    "```",
    "",
    "Post to the board (anchor to the most relevant file + line):",
    "```sh",
    `hunk session comment add --repo ${repo} --file <path> --new-line <n> \\`,
    `  --author "<your role or name>" --summary "<one-line entry>" --rationale "<details>"`,
    "```",
    "",
    "Conventions:",
    "- ALWAYS pass `--author` with your agent role/name so others know who wrote each entry.",
    "- Read the board first; do not duplicate a claim another agent already posted.",
    '- Keep entries short and actionable: claims ("claiming <task>"), findings, handoffs, blockers.',
    "- Anchor each entry to the file/line it concerns; for non-code coordination, anchor to a stable file (e.g. README or an agreed coordination file) line 1.",
    "- The full Hunk CLI is in the bundled `hunk-review` skill: run `hunk skill path hunk-review` and read that file.",
    "",
  ].join("\n");
}

/** Prepend the blackboard block to a child prompt when a session exists. */
export function withBlackboard(prompt: string, info: BlackboardInfo | null) {
  return info ? `${blackboardPromptBlock(info)}\n${prompt}` : prompt;
}

/** Kill any auto-provisioned PTY sessions. Idempotent; safe on shutdown. */
export function disposeBlackboards(): void {
  for (const child of ptyChildren) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort teardown.
    }
  }
  ptyChildren.clear();
  sessions.clear();
}
