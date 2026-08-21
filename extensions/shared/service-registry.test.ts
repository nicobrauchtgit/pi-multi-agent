import assert from "node:assert/strict";
import test from "node:test";
import { bindChildSessionExtensions } from "./child-session.ts";
import { NOOP_OBSERVABILITY_SINK } from "./observability/sink.ts";
import {
  acquireProcessService,
  currentProcessService,
  disposeProcessService,
  provideProcessService,
  resetProcessServiceRegistryForTests,
} from "./service-registry.ts";

function resources(name: string) {
  return {
    runtime: { name },
    manager: Promise.resolve({ name }),
    sink: NOOP_OBSERVABILITY_SINK,
  };
}

test("duplicate module instances share one versioned global service", async () => {
  resetProcessServiceRegistryForTests();
  const duplicate = await import(
    new URL("./service-registry.ts?duplicate=1", import.meta.url).href
  );
  try {
    const first = provideProcessService(resources("first"));
    const acquired = await duplicate.acquireProcessService({ timeoutMs: 0 });
    assert.equal(acquired, first);
    assert.equal(acquired.runtime.name, "first");
    assert.throws(
      () => duplicate.provideProcessService(resources("duplicate")),
      /already exists/,
    );
  } finally {
    duplicate.resetProcessServiceRegistryForTests();
  }
});

test("consumers wait across load order and time out clearly without a provider", async () => {
  resetProcessServiceRegistryForTests();
  const waiting = acquireProcessService<{ name: string }, { name: string }>({
    timeoutMs: 100,
  });
  setTimeout(() => provideProcessService(resources("late")), 5);
  assert.equal((await waiting).runtime.name, "late");
  resetProcessServiceRegistryForTests();
  await assert.rejects(
    acquireProcessService({ timeoutMs: 5 }),
    /subagents process service is unavailable/i,
  );
});

test("owner disposal bumps epoch, aborts consumers, and permits reload takeover", () => {
  resetProcessServiceRegistryForTests();
  const first = provideProcessService(resources("first"), {
    ownerToken: "owner-first",
  });
  assert.equal(disposeProcessService("wrong-owner"), false);
  assert.equal(first.isCurrent(), true);
  assert.equal(disposeProcessService(first.ownerToken), true);
  assert.equal(first.isCurrent(), false);
  assert.equal(first.shutdownSignal.aborted, true);
  assert.equal(currentProcessService(), undefined);

  const second = provideProcessService(resources("second"), {
    ownerToken: "owner-second",
  });
  assert.ok(second.epoch > first.epoch);
  assert.equal(second.isCurrent(), true);
  resetProcessServiceRegistryForTests();
});

test("child extension binding can neither provide nor acquire the parent service", async () => {
  resetProcessServiceRegistryForTests();
  let provideError: unknown;
  let acquireError: unknown;
  await bindChildSessionExtensions({
    async bindExtensions() {
      try {
        provideProcessService(resources("child"));
      } catch (error) {
        provideError = error;
      }
      try {
        await acquireProcessService({ timeoutMs: 0 });
      } catch (error) {
        acquireError = error;
      }
    },
  });
  assert.match(String(provideError), /child-session extensions are loading/);
  assert.match(String(acquireError), /child-session extensions are loading/);
  assert.equal(currentProcessService(), undefined);
  resetProcessServiceRegistryForTests();
});
