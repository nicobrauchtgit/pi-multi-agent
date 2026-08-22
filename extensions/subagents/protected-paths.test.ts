import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHILD_BACKEND_PATH_CAPABILITIES,
  ProtectedPathAccessError,
  assertChildWorkingDirectoryAllowed,
  childProcessEnvironment,
  createProtectedPathToolGuard,
  processRichCaptureAllowed,
  protectedPathPolicy,
} from "../shared/child-session.ts";
import { observabilityPaths } from "../shared/observability/home.mjs";
import { claudeProtectedPathHooks } from "./src/backends/claude.ts";
import { CODEX_PROTECTED_PATH_ENFORCEMENT } from "./src/backends/codex.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-path-d2-"));
  fs.chmodSync(root, 0o700);
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  const moshi = path.join(root, "moshi", "sessions");
  fs.mkdirSync(agentDir, { mode: 0o700 });
  fs.mkdirSync(project);
  fs.mkdirSync(moshi, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    agentDir,
    project,
    moshi,
    paths: observabilityPaths(agentDir),
  };
}

test("canonical child policy denies direct, relative, symlink, search, artifacts, and Moshi paths", (t) => {
  const { root, agentDir, project, moshi, paths } = fixture(t);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.ingestToken, "x", { mode: 0o600 });
  const link = path.join(project, "linked-token");
  fs.symlinkSync(paths.ingestToken, link);
  const policy = protectedPathPolicy({ agentDir, moshiPaths: [moshi] });

  for (const input of [
    { path: paths.ingestToken },
    { path: path.relative(project, paths.database) },
    { path: link },
    { path: paths.workflowsDir },
    { path: paths.runArtifactsDir },
    { path: path.join(moshi, "session.json") },
  ]) {
    assert.equal(policy.decide("read", input, project).denied, true);
    assert.equal(policy.decide("write", input, project).denied, true);
    assert.equal(policy.decide("edit", input, project).denied, true);
  }
  assert.equal(policy.decide("find", { path: root }, project).denied, true);
  assert.equal(
    policy.decide("grep", { path: `${root}/**` }, project).denied,
    true,
  );
  assert.equal(
    policy.decide("read", { path: "README.md" }, project).denied,
    false,
  );
  // Shell text matching is deliberately not claimed as a security boundary.
  assert.equal(
    policy.decide("bash", { command: `cat ${paths.ingestToken}` }, project)
      .denied,
    false,
  );
});

test("implicit cwd and tool-specific search globs cannot enumerate protected roots", (t) => {
  const { root, agentDir, project, paths } = fixture(t);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const policy = protectedPathPolicy({ agentDir });

  for (const [tool, input] of [
    ["grep", { pattern: "." }],
    ["find", { pattern: "**/observability/*" }],
    ["ls", {}],
  ] as const) {
    assert.equal(policy.decide(tool, input, root).denied, true, tool);
    assert.equal(policy.decide(tool, input, paths.root).denied, true, tool);
  }
  assert.equal(
    policy.decide("grep", { pattern: ".", path: project }, root).denied,
    false,
  );
  assert.equal(
    policy.decide(
      "grep",
      { pattern: ".", path: root, glob: "**/observability/*" },
      project,
    ).denied,
    true,
  );
  assert.equal(
    policy.decide("find", { path: project, pattern: "**/*.ts" }, root).denied,
    false,
  );
  assert.throws(
    () => assertChildWorkingDirectoryAllowed(paths.root, policy),
    ProtectedPathAccessError,
  );
  assert.throws(
    () => assertChildWorkingDirectoryAllowed(root, policy),
    ProtectedPathAccessError,
  );
  assert.equal(
    assertChildWorkingDirectoryAllowed(project, policy),
    fs.realpathSync.native(project),
  );
});

test("Pi file tool definitions are denied at execute time", async (t) => {
  const { agentDir, project, paths } = fixture(t);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const definition: ToolDefinition = {
    name: "read",
    label: "read",
    description: "fixture",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      return {
        content: [{ type: "text", text: "should not run" }],
        details: {},
      };
    },
  };
  const registry = {
    getAllTools: () => [{ name: "read" }],
    getToolDefinition: () => definition,
  };
  createProtectedPathToolGuard(protectedPathPolicy({ agentDir })).apply(
    registry,
  );
  await assert.rejects(
    definition.execute("call", { path: paths.config }, undefined, undefined, {
      cwd: project,
    } as never),
    ProtectedPathAccessError,
  );
});

test("Claude PreToolUse denies protected file tools under bypassPermissions", async (t) => {
  const { agentDir, project, paths } = fixture(t);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const hooks = claudeProtectedPathHooks(
    project,
    protectedPathPolicy({ agentDir }),
  );
  const callback = hooks.PreToolUse[0]!.hooks[0]!;
  const denied = await callback(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: paths.ingestToken },
      tool_use_id: "tool",
      session_id: "session",
      transcript_path: "transcript",
      cwd: project,
      permission_mode: "bypassPermissions",
    } as never,
    "tool",
    { signal: new AbortController().signal },
  );
  const deniedOutput = denied as {
    hookSpecificOutput?: {
      hookEventName?: string;
      permissionDecision?: string;
    };
  };
  assert.equal(
    deniedOutput.hookSpecificOutput?.hookEventName === "PreToolUse"
      ? deniedOutput.hookSpecificOutput.permissionDecision
      : undefined,
    "deny",
  );
  const allowed = await callback(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: path.join(project, "README.md") },
      tool_use_id: "tool-2",
      session_id: "session",
      transcript_path: "transcript",
      cwd: project,
      permission_mode: "bypassPermissions",
    } as never,
    "tool-2",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(allowed, {});
});

test("observability controls and paths are stripped from external child environments", () => {
  assert.deepEqual(
    childProcessEnvironment({
      PATH: "/bin",
      PI_OBSERVABILITY_TEST_AGENT_DIR: "/secret/companion-home",
      PI_OBSERVABILITY_TOKEN: "secret",
    }),
    { PATH: "/bin" },
  );
});

test("unenforceable shell/Codex boundaries force process-wide metadata-only capture", () => {
  assert.equal(CHILD_BACKEND_PATH_CAPABILITIES.pi.fileTools, true);
  assert.equal(CHILD_BACKEND_PATH_CAPABILITIES.pi.shell, false);
  assert.equal(CHILD_BACKEND_PATH_CAPABILITIES.claude.fileTools, true);
  assert.equal(CHILD_BACKEND_PATH_CAPABILITIES.claude.shell, false);
  assert.deepEqual(CODEX_PROTECTED_PATH_ENFORCEMENT.richCapture, false);
  assert.equal(processRichCaptureAllowed(["pi"]), false);
  assert.equal(processRichCaptureAllowed(["pi", "claude", "codex"]), false);
});
