import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { companionHome, resolveAgentDir } from "../../companion/src/home.mjs";
import { getRoleLocksDir } from "../subagents/src/role-lock.ts";

test("companion and TypeScript role-lock agent-dir resolution stay in parity", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    for (const configured of [
      undefined,
      "~",
      "~/custom-agent",
      "./relative-agent",
    ]) {
      if (configured === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = configured;
      const resolved = resolveAgentDir();
      assert.equal(
        path.dirname(companionHome(resolved)),
        path.dirname(getRoleLocksDir()),
      );
      if (configured === "~") assert.equal(resolved, os.homedir());
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
