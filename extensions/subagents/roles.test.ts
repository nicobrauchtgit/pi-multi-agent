import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getRole, upsertRole } from "./src/roles.ts";

function withAgentDir(run: (agentDir: string) => void) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-roles-"));
  try {
    run(agentDir);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("ordinary role updates preserve an existing native locator", () => {
  withAgentDir((agentDir) => {
    upsertRole(
      {
        role: "reviewer",
        title: "old",
        backend: "claude",
        cwd: "/tmp/old",
        nativeSessionId: "old-session",
        sessionFilePath: "/tmp/old.jsonl",
      },
      agentDir,
    );
    upsertRole(
      {
        role: "reviewer",
        title: "updated",
        backend: "claude",
        cwd: "/tmp/new",
      },
      agentDir,
    );

    const record = getRole("reviewer", agentDir);
    assert.equal(record?.nativeSessionId, "old-session");
    assert.equal(record?.sessionFilePath, "/tmp/old.jsonl");
  });
});

test("a fresh spawn clears the previous native locator", () => {
  withAgentDir((agentDir) => {
    upsertRole(
      {
        role: "reviewer",
        title: "old",
        backend: "claude",
        cwd: "/tmp/old",
        nativeSessionId: "old-session",
        sessionFilePath: "/tmp/old.jsonl",
      },
      agentDir,
    );
    upsertRole(
      {
        role: "reviewer",
        title: "fresh",
        backend: "claude",
        cwd: "/tmp/new",
        resetNativeLocator: true,
        status: "running",
      },
      agentDir,
    );

    const record = getRole("reviewer", agentDir);
    assert.equal(record?.nativeSessionId, undefined);
    assert.equal(record?.sessionFilePath, undefined);
    assert.equal(record?.status, "running");
  });
});
