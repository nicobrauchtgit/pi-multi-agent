import assert from "node:assert/strict";
import test from "node:test";
import type { Cause, Scope } from "effect";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import {
  BackendRegistry,
  type SubagentBackend,
  type SubagentSession,
} from "./src/backend.ts";
import {
  makePiHandoffSession,
  type PiSessionSegmentFactory,
} from "./src/backends/pi.ts";
import type { SpawnTask, SubagentEvent, SubagentMeta } from "./src/domain.ts";
import { SendError } from "./src/domain.ts";
import { handoffDecision } from "./src/handoff/policy.ts";
import {
  createHandoffRecorder,
  handoffDocumentFromAgentText,
} from "./src/handoff/controller.ts";
import { buildContinuationPrompt } from "./src/handoff/prompt.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";

const policy = {
  enabled: true,
  tokenThreshold: 120_000,
  ratioThreshold: 0.8,
  reserveTokens: 16_000,
};

test("handoff policy uses context-window reserve before absolute threshold", () => {
  assert.equal(
    handoffDecision({ tokens: 63_900, contextWindow: 100_000 }, policy)
      .shouldHandoff,
    false,
  );
  const decision = handoffDecision(
    { tokens: 64_000, contextWindow: 100_000 },
    policy,
  );
  assert.equal(decision.shouldHandoff, true);
  assert.match(decision.reason ?? "", /64000\/100000/);
});

test("handoff policy uses the lower absolute threshold for large contexts", () => {
  assert.equal(
    handoffDecision({ tokens: 119_999, contextWindow: 1_050_000 }, policy)
      .shouldHandoff,
    false,
  );
  const decision = handoffDecision(
    { tokens: 120_000, contextWindow: 1_050_000 },
    policy,
  );
  assert.equal(decision.shouldHandoff, true);
  assert.match(decision.reason ?? "", /120000\/1050000/);
});

test("handoff policy stays off when disabled or usage is missing", () => {
  assert.equal(
    handoffDecision(
      { tokens: 1_000_000, contextWindow: 1_100_000 },
      { ...policy, enabled: false },
    ).shouldHandoff,
    false,
  );
  assert.equal(handoffDecision({}, policy).shouldHandoff, false);
  assert.equal(
    handoffDecision({ tokens: Number.NaN, contextWindow: 100_000 }, policy)
      .shouldHandoff,
    false,
  );
});

test("handoff policy falls back to absolute token threshold without context window", () => {
  assert.equal(
    handoffDecision({ tokens: 119_999 }, policy).shouldHandoff,
    false,
  );
  const decision = handoffDecision({ tokens: 120_000 }, policy);
  assert.equal(decision.shouldHandoff, true);
  assert.match(decision.reason ?? "", /120000/);
});

test("handoff recorder builds a bounded generic document from events", () => {
  const recorder = createHandoffRecorder("Fix the workflow dashboard.");
  recorder.record({ kind: "user", text: "Please make the UI readable." });
  recorder.record({
    kind: "assistant",
    text: "Implemented React cards and markdown rendering.",
  });
  recorder.record({
    kind: "tool",
    name: "bash",
    text: "npm run check",
  });
  recorder.record({
    kind: "tool",
    name: "bash",
    isError: true,
    text: "npm run test failed",
  });
  recorder.record({ kind: "usage", tokens: 64_000, contextWindow: 100_000 });

  const document = recorder.document("threshold reached");
  assert.match(document.summary, /Implemented React cards/);
  assert.match(document.currentState, /threshold reached/);
  assert.match(document.currentState, /64000\/100000/);
  assert.deepEqual(document.checksRun, [
    "bash: npm run check",
    "bash failed: npm run test failed",
  ]);
  assert.deepEqual(document.nextSteps, [
    "Continue the latest requested work from the carried state.",
  ]);
});

test("handoff recorder records backend errors as open issues", () => {
  const recorder = createHandoffRecorder("Investigate failure.");
  recorder.record({ kind: "error", text: "provider timeout" });
  const document = recorder.document("manual rollover");
  assert.deepEqual(document.openIssues, ["provider timeout"]);
  assert.match(document.currentState, /Investigate failure/);
});

test("handoff recorder truncates oversized summaries", () => {
  const recorder = createHandoffRecorder("x".repeat(20_000));
  recorder.record({ kind: "final", text: "y".repeat(20_000) });
  const document = recorder.document("large context");
  assert.ok(document.summary.length <= 2049);
  assert.ok(document.currentState.length <= 12 * 1024 + 1);
});

test("agent-written handoff text replaces recorder fallback without carrying old transcript", () => {
  const fallback =
    createHandoffRecorder("Original task").document("threshold reached");
  const document = handoffDocumentFromAgentText(
    "Task: finish workflow cards\nCursor: tool cards render, duration still wrong\nNext: fix active duration",
    fallback,
  );
  assert.match(document.summary, /Cursor: tool cards render/);
  assert.equal(document.currentState, document.summary);
  assert.doesNotMatch(document.currentState, /threshold reached/);
});

test("handoff continuation prompt carries original prompt, next prompt, and summary", () => {
  const prompt = buildContinuationPrompt({
    originalPrompt: "Investigate the failing test.",
    nextPrompt: "Continue after handoff.",
    handoff: {
      summary: "Found failing assertion.",
      currentState: "Need to update workflow rows.",
      filesTouched: ["extensions/workflows/dashboard.ts"],
      checksRun: ["npm run check"],
      openIssues: ["Need regression test"],
      nextSteps: ["Add test"],
      risks: ["Schema drift"],
    },
  });
  assert.match(prompt, /Investigate the failing test/);
  assert.match(prompt, /Continue after handoff/);
  assert.match(prompt, /Found failing assertion/);
  assert.match(prompt, /extensions\/workflows\/dashboard\.ts/);
});

function deadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for Pi handoff settlement")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test("idle Pi rollover preserves both terminal events for manager waiters", async () => {
  const segmentPrompts: string[] = [];
  const segmentSends: string[] = [];

  const createSegment: PiSessionSegmentFactory = (
    task: SpawnTask,
  ): Effect.Effect<SubagentSession, never, Scope.Scope> =>
    Effect.gen(function* () {
      const index = segmentPrompts.push(task.prompt);
      const meta: SubagentMeta = {
        backend: "pi",
        modelLabel: "pi/fake",
        contextWindow: 1_050_000,
        sessionFilePath: `/tmp/fake-pi-segment-${index}.jsonl`,
        nativeSessionId: `fake-pi-segment-${index}`,
      };
      const events = yield* Queue.make<SubagentEvent, Cause.Done>();
      let closed = false;
      const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          Queue.endUnsafe(events);
        }),
      );

      emit({ _tag: "MetaChanged", meta });
      emit({ _tag: "UserMessage", text: task.prompt });
      emit({ _tag: "RunStarted" });
      if (index === 1) {
        emit({
          _tag: "UsageChanged",
          tokens: 120_000,
          contextWindow: 1_050_000,
        });
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Completed", finalText: "first result" },
        });
      } else {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Completed", finalText: "fresh segment result" },
        });
      }

      return {
        meta: Effect.succeed(meta),
        events: Stream.fromQueue(events),
        send: (text) =>
          Effect.suspend(() => {
            if (closed) {
              return new SendError({ message: "Fake segment is closed." });
            }
            segmentSends.push(text);
            emit({ _tag: "UserMessage", text });
            emit({ _tag: "RunStarted" });
            emit({
              _tag: "RunSettled",
              outcome: {
                _tag: "Completed",
                finalText:
                  "Cursor: first run settled. Next: continue in a fresh segment.",
              },
            });
            return Effect.void;
          }),
        interrupt: Effect.void,
      } satisfies SubagentSession;
    });

  const backend: SubagentBackend = {
    name: "pi",
    capabilities: {
      steering: true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (task) => makePiHandoffSession(task, createSegment),
  };
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(Layer.succeed(BackendRegistry, new Map([["pi", backend]]))),
    ),
  );

  try {
    const manager = await runtime.runPromise(SubagentManager);
    const started = await runtime.runPromise(
      manager.spawn("pi", {
        prompt: "Review the adapter.",
        title: "fake rollover",
        cwd: process.cwd(),
        parent: { parentCwd: process.cwd(), projectTrusted: false },
      }),
    );

    await deadline(runtime.runPromise(manager.waitFor([started.id])));
    assert.equal(manager.view.get(started.id)?.finalText, "first result");
    assert.equal(segmentPrompts.length, 1, "an active run must not roll over");

    await deadline(
      runtime.runPromise(manager.send(started.id, "Continue the review.")),
    );
    await deadline(runtime.runPromise(manager.waitFor([started.id])));

    const settled = manager.view.get(started.id);
    assert.equal(settled?.id, started.id);
    assert.equal(settled?.status, "done");
    assert.equal(settled?.finalText, "fresh segment result");
    assert.equal(settled?.meta.nativeSessionId, "fake-pi-segment-2");
    assert.equal(segmentPrompts.length, 2);
    assert.equal(segmentSends.length, 1);
    assert.match(segmentSends[0], /active implementation agent/i);
    assert.match(segmentPrompts[1], /Continue the review/);
    assert.match(segmentPrompts[1], /first run settled/);
  } finally {
    await runtime.dispose();
  }
});
