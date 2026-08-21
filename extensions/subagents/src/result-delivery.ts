import type { SubagentOrigin } from "./domain.ts";

export type ResultDeliveryChannel = "standalone" | "btw" | "none";

/** Select the existing parent delivery path without leaking workflow results. */
export function resultDeliveryChannel(entry: {
  readonly origin: SubagentOrigin;
  readonly autoDeliver: boolean;
}): ResultDeliveryChannel {
  if (entry.origin === "btw") return "btw";
  if (entry.origin === "workflow" || !entry.autoDeliver) return "none";
  return "standalone";
}

export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}
