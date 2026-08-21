import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflowSandbox } from "./sandbox.ts";

function run(
  source: string,
  overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {},
) {
  const abort = new AbortController();
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    signal: abort.signal,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    ...overrides,
  });
}

test("sandbox exposes only workflow capabilities and validates results", async () => {
  const phases: string[] = [];
  const result = await run(
    `
      phase("Gather");
      const replies = await parallel([
        () => agent("one"),
        () => agent("two"),
      ], { concurrency: 99 });
      return {
        replies: replies.map((reply) => reply.output),
        processType: typeof process,
        processKeys: Object.keys(process),
        requireType: typeof require,
        fetchType: typeof fetch,
      };
    `,
    { onPhase: (title) => phases.push(title) },
  );
  assert.deepEqual(result, {
    replies: ["reply:one", "reply:two"],
    processType: "object",
    processKeys: ["cwd"],
    requireType: "undefined",
    fetchType: "undefined",
  });
  assert.deepEqual(phases, ["Gather"]);
});

test("sandbox passes the C1 agent option vocabulary and drops unknown keys", async () => {
  let received: unknown;
  const result = await run(
    `return await agent("review", {
      harness: "codex",
      label: "reviewer",
      phase: "Review",
      schema: { type: "object", properties: {} },
      model: "gpt-test",
      provider: "fixture",
      effort: "high",
      unknown: "drop-me",
    });`,
    {
      onAgent: async (_prompt, options) => {
        received = options;
        return { ok: true, output: "ok" };
      },
    },
  );
  assert.deepEqual(result, { ok: true, output: "ok" });
  assert.deepEqual(received, {
    harness: "codex",
    label: "reviewer",
    phase: "Review",
    schema: { type: "object", properties: {} },
    model: "gpt-test",
    provider: "fixture",
    effort: "high",
  });
});

test("sandbox pipeline fans out items while running stages sequentially", async () => {
  let active = 0;
  let maxActive = 0;
  const result = await run(
    `
      return await pipeline(
        [1, 2, 3, 4, 5, 6],
        async (previous, original, index) => {
          await agent("stage1:" + original + ":" + index);
          return previous * 2;
        },
        (previous, original, index) => previous + original + index,
      );
    `,
    {
      onAgent: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { ok: true, output: "ok" };
      },
    },
  );

  assert.deepEqual(result, [3, 7, 11, 15, 19, 23]);
  assert.equal(maxActive, 4);
});

test("sandbox pipeline validates inputs", async () => {
  await assert.rejects(
    run(`return await pipeline("nope", (item) => item);`),
    /pipeline\(\) expects an array/,
  );
  await assert.rejects(
    run(`return await pipeline([1], "nope");`),
    /pipeline\(\) stages must be functions/,
  );
});

test("sandbox log sends bounded messages to the parent", async () => {
  const logs: string[] = [];
  const result = await run(
    `
      log("hello");
      log("x".repeat(1000));
      return "done";
    `,
    { onLog: (message) => logs.push(message) },
  );

  assert.equal(result, "done");
  assert.equal(logs[0], "hello");
  assert.equal(logs[1].length, 512);
});

test("sandbox exposes deterministic cwd and no real process capabilities", async () => {
  const expectedCwd = process.cwd();
  const result = await run(
    `
      return {
        cwd,
        processCwd: process.cwd(),
        cwdFrozen: Object.isFrozen(cwd),
        processFrozen: Object.isFrozen(process),
        processKeys: Object.keys(process),
        envType: typeof process.env,
        sendType: typeof process.send,
        bindingType: typeof process.binding,
        getBuiltinModuleType: typeof process.getBuiltinModule,
      };
    `,
    { cwd: expectedCwd },
  );

  assert.deepEqual(result, {
    cwd: expectedCwd,
    processCwd: expectedCwd,
    cwdFrozen: true,
    processFrozen: true,
    processKeys: ["cwd"],
    envType: "undefined",
    sendType: "undefined",
    bindingType: "undefined",
    getBuiltinModuleType: "undefined",
  });
});

test("sandbox result serialization handles cycles and bigint", async () => {
  const result = await run(`
    const value = { count: 7n };
    value.self = value;
    return value;
  `);
  assert.deepEqual(result, { count: "7n", self: "[circular]" });
});

test("sandbox rejects unawaited agent calls", async () => {
  let calls = 0;
  await assert.rejects(
    run(`agent("orphan"); return "done";`, {
      onAgent: async () => {
        calls++;
        return { ok: true, output: "unexpected" };
      },
    }),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox source cannot escape the host accounting wrapper", async () => {
  let calls = 0;
  await assert.rejects(
    run(
      `}), agent("orphan"), Promise.resolve("bypass"); (async function () {`,
      {
        onAgent: async () => {
          calls++;
          return { ok: true, output: "unexpected" };
        },
      },
    ),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox VM still rejects non-yielding synchronous code", async () => {
  await assert.rejects(run(`while (true) {}`), /timed out/);
});

test("workflow agent invocations have no per-request wall timer", async () => {
  let signalAborted = false;
  const result = await run(`return (await agent("delayed")).output;`, {
    onAgent: async (_prompt, _options, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      signalAborted = signal.aborted;
      return { ok: true, output: "completed" };
    },
  });

  assert.equal(result, "completed");
  assert.equal(signalAborted, false);
});

test("workflow cancellation aborts a pending agent request", async () => {
  const controller = new AbortController();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let requestAborted = false;
  const pending = run(`return await agent("pending");`, {
    signal: controller.signal,
    onAgent: async (_prompt, _options, signal) => {
      startedResolve?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { ok: false, output: "", error: "Agent was aborted" };
    },
  });

  await started;
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(pending, /Workflow was aborted/);
  assert.equal(requestAborted, true);
});
