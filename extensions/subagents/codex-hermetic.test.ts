import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const fakeCodexSource = String.raw`#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.FAKE_CODEX_LOG;
let turn = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (log) fs.appendFileSync(log, JSON.stringify(message) + "\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: {
      userAgent: "pi-subagents/" + (process.env.FAKE_CODEX_VERSION || "0.147.0") + " (test; arm64)"
    }});
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: {
      thread: { id: "fake-thread", path: "/tmp/fake-codex.jsonl" },
      model: "fake-codex"
    }});
    return;
  }
  if (message.method === "turn/start") {
    turn++;
    const turnId = "turn-" + turn;
    const text = message.params?.input?.[0]?.text || "";
    send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { turn: { id: turnId } } });
      const finalText = text.includes("INVALID")
        ? JSON.stringify({ turn: "wrong" })
        : JSON.stringify({ turn, text });
      send({ method: "item/completed", params: {
        turnId,
        item: { id: "message-" + turn, type: "agentMessage", phase: "final_answer", text: finalText }
      }});
      send({ method: "turn/completed", params: {
        turn: { id: turnId, status: "completed" }
      }});
    }, 5);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`;

function task(prompt: string, schema?: unknown) {
  return {
    prompt,
    title: "fake Codex",
    cwd: process.cwd(),
    schema,
    parent: { parentCwd: process.cwd(), projectTrusted: false },
  };
}

test("real Codex backend wiring preserves schemas and validates every turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const binary = path.join(directory, "codex");
  const log = path.join(directory, "requests.jsonl");
  fs.writeFileSync(binary, fakeCodexSource, { mode: 0o755 });

  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_CODEX_LOG;
  const oldVersion = process.env.FAKE_CODEX_VERSION;
  process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ""}`;
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_VERSION = "0.147.0";

  const schema = {
    type: "object",
    properties: {
      turn: { type: "number" },
      text: { type: "string" },
    },
    required: ["turn", "text"],
    additionalProperties: false,
  };

  const { SubagentManager } = await import("./src/manager.ts");
  const { createSubagentRuntime, runTool } = await import("./src/runtime.ts");
  const runtime = createSubagentRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const started = await runTool(
      runtime,
      manager.spawn("codex", task("first", schema)),
    );
    await runTool(runtime, manager.waitFor([started.id]));
    assert.deepEqual(manager.view.get(started.id)?.structured, {
      turn: 1,
      text: "first",
    });

    await runTool(runtime, manager.send(started.id, "INVALID second"));
    await runTool(runtime, manager.waitFor([started.id]));
    const invalid = manager.view.get(started.id);
    assert.equal(invalid?.status, "error");
    assert.match(invalid?.schemaError ?? "", /turn.*number/);

    await runTool(runtime, manager.send(started.id, "third"));
    await runTool(runtime, manager.waitFor([started.id]));
    assert.deepEqual(manager.view.get(started.id)?.structured, {
      turn: 3,
      text: "third",
    });

    const requests = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const turns = requests.filter((request) => request.method === "turn/start");
    assert.equal(turns.length, 3);
    for (const request of turns) {
      assert.deepEqual(request.params.outputSchema, schema);
    }

    process.env.FAKE_CODEX_VERSION = "0.146.9";
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("unsupported", schema))),
      /does not support outputSchema.*0\.147\.0/,
    );
  } finally {
    await runtime.dispose();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = oldLog;
    if (oldVersion === undefined) delete process.env.FAKE_CODEX_VERSION;
    else process.env.FAKE_CODEX_VERSION = oldVersion;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
