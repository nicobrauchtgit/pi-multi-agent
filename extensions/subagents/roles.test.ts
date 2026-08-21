import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  encodeRoleFileName,
  getRole,
  getRolesDir,
  roleUpsertFromSnapshot,
  updateRole,
  upsertRole,
} from "./src/roles.ts";

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

test("role records round-trip bounded schemas and remain backward compatible", () => {
  withAgentDir((agentDir) => {
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    upsertRole(
      {
        role: "structured-reviewer",
        title: "reviewer",
        backend: "codex",
        cwd: "/tmp/repo",
        schema,
      },
      agentDir,
    );
    assert.deepEqual(getRole("structured-reviewer", agentDir)?.schema, schema);

    upsertRole(
      {
        role: "legacy-reviewer",
        title: "legacy",
        backend: "claude",
        cwd: "/tmp/repo",
      },
      agentDir,
    );
    assert.equal(getRole("legacy-reviewer", agentDir)?.schema, undefined);

    const file = path.join(
      getRolesDir(agentDir),
      encodeRoleFileName("structured-reviewer"),
    );
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.schema = { constructor: { type: "string" } };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    const unsafe = getRole("structured-reviewer", agentDir);
    assert.equal(unsafe?.schema, undefined);
    assert.equal(unsafe?.status, "missing");
    assert.match(unsafe?.schemaError ?? "", /schema is invalid/i);

    record.schema = { description: "x".repeat(70 * 1024) };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    const oversized = getRole("structured-reviewer", agentDir);
    assert.equal(oversized?.schema, undefined);
    assert.equal(oversized?.status, "missing");
    assert.match(oversized?.schemaError ?? "", /schema is invalid/i);
  });
});

test("settlement role updates preserve the session schema", () => {
  withAgentDir((agentDir) => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const snapshot = {
      id: "sa-1",
      origin: "model",
      autoDeliver: true,
      backend: "pi",
      title: "reviewer",
      prompt: "review",
      cwd: "/tmp/repo",
      role: "reviewer",
      status: "running",
      createdAt: Date.now(),
      meta: { backend: "pi", nativeSessionId: "session-1" },
      usage: {},
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "",
      turns: 0,
    } satisfies SubagentSnapshot;

    const initial = roleUpsertFromSnapshot(snapshot, { schema });
    assert.ok(initial);
    upsertRole(initial, agentDir);
    const settled = roleUpsertFromSnapshot({
      ...snapshot,
      status: "done",
      finalText: "done",
    });
    assert.ok(settled);
    upsertRole(settled, agentDir);
    assert.deepEqual(getRole("reviewer", agentDir)?.schema, schema);
  });
});

test("a fresh spawn clears the previous native locator and schema", () => {
  withAgentDir((agentDir) => {
    upsertRole(
      {
        role: "reviewer",
        title: "old",
        backend: "claude",
        cwd: "/tmp/old",
        nativeSessionId: "old-session",
        sessionFilePath: "/tmp/old.jsonl",
        schema: { type: "object", properties: {} },
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
    assert.equal(record?.schema, undefined);
    assert.equal(record?.status, "running");
  });
});

test("a live schema-less role can clear a stale persisted contract", () => {
  withAgentDir((agentDir) => {
    upsertRole(
      {
        role: "reviewer",
        title: "reviewer",
        backend: "claude",
        cwd: "/tmp/repo",
        schema: { type: "object", properties: {} },
      },
      agentDir,
    );
    updateRole("reviewer", { clearSchema: true, schema: undefined }, agentDir);
    assert.equal(getRole("reviewer", agentDir)?.schema, undefined);
  });
});

test("role persistence rejects invalid schemas", () => {
  withAgentDir((agentDir) => {
    assert.throws(
      () =>
        upsertRole(
          {
            role: "invalid",
            title: "invalid",
            backend: "pi",
            cwd: "/tmp/repo",
            schema: { type: "bogus" },
          },
          agentDir,
        ),
      /Cannot persist an invalid structured-output schema/,
    );
  });
});
