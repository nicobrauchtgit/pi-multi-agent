import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { SubagentManager } from "./src/manager.ts";
import { claudeBackend } from "./src/backends/claude.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Claude test",
    cwd: process.cwd(),
    model: "haiku",
    reasoningEffort: "off",
    parent,
  };
}

async function claudeAvailable() {
  return Effect.runPromise(claudeBackend.available);
}

/** Rejecting deadline so a hung wait still reaches finally() and disposes. */
function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Claude test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test(
  "Claude backend completes a live manager run",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn("claude", task("Reply with exactly: hello claude")),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);

      const done = manager.view.get(started.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello claude/i);
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath?.endsWith(".jsonl"));
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude backend validates structured output on repeated turns",
  { timeout: 90_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const structuredTask = {
        ...task("Return only JSON with turn 1 and word first."),
        schema: {
          type: "object",
          properties: {
            turn: { type: "number" },
            word: { type: "string" },
          },
          required: ["turn", "word"],
          additionalProperties: false,
        },
      };
      const started = await runTool(
        runtime,
        manager.spawn("claude", structuredTask),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);
      assert.deepEqual(manager.view.get(started.id)?.structured, {
        turn: 1,
        word: "first",
      });

      await runTool(
        runtime,
        manager.send(
          started.id,
          "Return only JSON with turn 2 and word second.",
        ),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);
      const followedUp = manager.view.get(started.id);
      assert.equal(followedUp?.status, "done");
      assert.deepEqual(followedUp?.structured, {
        turn: 2,
        word: "second",
      });
      assert.equal(followedUp?.schemaError, undefined);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude backend interrupt settles a live run as aborted",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn(
          "claude",
          task(
            "Write a detailed 10,000-word essay about the history of computing.",
          ),
        ),
      );

      // Wait for streamed output so cancellation definitely lands mid-run and
      // exercises the SDK's normal interrupt receipt/result path.
      const streamDeadline = Date.now() + 15_000;
      while (
        manager.view.get(started.id)?.status === "running" &&
        !manager.view.get(started.id)?.liveAssistant?.text &&
        Date.now() < streamDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(manager.view.get(started.id)?.status, "running");
      assert.ok(manager.view.get(started.id)?.liveAssistant?.text);

      const report = await deadline(
        runTool(runtime, manager.cancel([started.id])),
        20_000,
      );

      assert.equal(report[0]?.cancelled, true);
      assert.equal(manager.view.get(started.id)?.status, "error");
      assert.equal(manager.view.get(started.id)?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);
