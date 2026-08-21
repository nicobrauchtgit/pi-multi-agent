import { randomUUID } from "node:crypto";
import { isChildExtensionLoad } from "./child-session.ts";
import type { ObservabilitySink } from "./observability/sink.ts";

export const PROCESS_SERVICE_VERSION = 1 as const;
export const MAX_PROCESS_SERVICE_WAITERS = 64;
const REGISTRY_KEY = Symbol.for("pi-multi-agent.process-service.registry.v1");
const DEACTIVATE_KEY = Symbol.for("pi-multi-agent.service.deactivate");

export interface ProcessServiceResources<Runtime = unknown, Manager = unknown> {
  readonly runtime: Runtime;
  readonly manager: Promise<Manager>;
  readonly sink: ObservabilitySink;
}

export interface ProcessServiceHandle<
  Runtime = unknown,
  Manager = unknown,
> extends ProcessServiceResources<Runtime, Manager> {
  readonly version: typeof PROCESS_SERVICE_VERSION;
  readonly epoch: number;
  readonly ownerToken: string;
  readonly shutdownSignal: AbortSignal;
  isCurrent(): boolean;
}

interface Waiter {
  readonly resolve: (handle: ProcessServiceHandle) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface RegistryState {
  readonly version: typeof PROCESS_SERVICE_VERSION;
  epoch: number;
  current?: ProcessServiceHandle;
  readonly waiters: Set<Waiter>;
}

function registry(): RegistryState {
  const root = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: RegistryState;
  };
  const current = root[REGISTRY_KEY];
  if (current?.version === PROCESS_SERVICE_VERSION) return current;
  const created: RegistryState = {
    version: PROCESS_SERVICE_VERSION,
    epoch: 0,
    waiters: new Set(),
  };
  root[REGISTRY_KEY] = created;
  return created;
}

function childLoadError(operation: string) {
  return new Error(
    `The process subagent service cannot ${operation} while child-session extensions are loading.`,
  );
}

function serviceUnavailableError() {
  return new Error(
    "The subagents process service is unavailable. Load the subagents extension and retry; workflows never fall back to a private runner.",
  );
}

/** Register the sole process owner. A second live owner is always rejected. */
export function provideProcessService<Runtime, Manager>(
  resources: ProcessServiceResources<Runtime, Manager>,
  options: { ownerToken?: string } = {},
): ProcessServiceHandle<Runtime, Manager> {
  if (isChildExtensionLoad()) throw childLoadError("be provided");
  const state = registry();
  if (state.current?.isCurrent()) {
    throw new Error(
      `A live subagents process service already exists at epoch ${state.current.epoch}.`,
    );
  }

  const ownerToken = options.ownerToken ?? `owner_${randomUUID()}`;
  const epoch = ++state.epoch;
  const shutdown = new AbortController();
  let active = true;
  let handle!: ProcessServiceHandle<Runtime, Manager>;
  handle = Object.freeze({
    version: PROCESS_SERVICE_VERSION,
    epoch,
    ownerToken,
    shutdownSignal: shutdown.signal,
    ...resources,
    isCurrent: () =>
      active &&
      !shutdown.signal.aborted &&
      registry().current === (handle as ProcessServiceHandle),
    [DEACTIVATE_KEY]: (reason: string) => {
      if (!active) return;
      active = false;
      shutdown.abort(new Error(reason));
    },
  });
  state.current = handle as ProcessServiceHandle;

  const waiters = [...state.waiters];
  state.waiters.clear();
  for (const waiter of waiters) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(handle as ProcessServiceHandle);
  }

  return handle;
}

/** Deregister only the matching owner, bumping the epoch before teardown. */
export function disposeProcessService(
  ownerToken: string,
  reason = "Subagent service was reloaded",
) {
  const state = registry();
  const current = state.current;
  if (!current || current.ownerToken !== ownerToken) return false;
  state.current = undefined;
  state.epoch++;
  const deactivate = (
    current as ProcessServiceHandle & {
      [DEACTIVATE_KEY]?: (reason: string) => void;
    }
  )[DEACTIVATE_KEY];
  deactivate?.(reason);
  return true;
}

export interface AcquireProcessServiceOptions {
  /** Zero performs an immediate diagnostic lookup. */
  readonly timeoutMs?: number;
}

/** Resolve lazily so extension load order is irrelevant. */
export function acquireProcessService<Runtime = unknown, Manager = unknown>(
  options: AcquireProcessServiceOptions = {},
): Promise<ProcessServiceHandle<Runtime, Manager>> {
  if (isChildExtensionLoad()) {
    return Promise.reject(childLoadError("be acquired"));
  }
  const state = registry();
  if (state.current?.isCurrent()) {
    return Promise.resolve(
      state.current as ProcessServiceHandle<Runtime, Manager>,
    );
  }

  const timeoutMs = Math.max(0, options.timeoutMs ?? 1_000);
  if (timeoutMs === 0) return Promise.reject(serviceUnavailableError());
  if (state.waiters.size >= MAX_PROCESS_SERVICE_WAITERS) {
    return Promise.reject(
      new Error(
        `The process subagent service wait queue is full (max ${MAX_PROCESS_SERVICE_WAITERS}).`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve: (handle) =>
        resolve(handle as ProcessServiceHandle<Runtime, Manager>),
      reject,
    };
    waiter.timer = setTimeout(() => {
      state.waiters.delete(waiter);
      reject(serviceUnavailableError());
    }, timeoutMs);
    waiter.timer.unref?.();
    state.waiters.add(waiter);
  });
}

export function currentProcessService() {
  const current = registry().current;
  return current?.isCurrent() ? current : undefined;
}

/** Test isolation for duplicate-module and lifecycle tests. */
export function resetProcessServiceRegistryForTests() {
  const state = registry();
  const current = state.current;
  if (current) disposeProcessService(current.ownerToken, "Test reset");
  for (const waiter of state.waiters) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(new Error("Process service registry was reset by a test."));
  }
  state.waiters.clear();
  state.current = undefined;
  state.epoch++;
}
