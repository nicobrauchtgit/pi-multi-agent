import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeferredResultDelivery,
  resultDeliveryChannel,
} from "./src/result-delivery.ts";

test("settlement routing preserves standalone and btw delivery while suppressing workflows", () => {
  assert.equal(
    resultDeliveryChannel({ origin: "model", autoDeliver: true }),
    "standalone",
  );
  assert.equal(
    resultDeliveryChannel({ origin: "model", autoDeliver: false }),
    "none",
  );
  assert.equal(
    resultDeliveryChannel({ origin: "workflow", autoDeliver: false }),
    "none",
  );
  assert.equal(
    resultDeliveryChannel({ origin: "workflow", autoDeliver: true }),
    "none",
  );
  assert.equal(
    resultDeliveryChannel({ origin: "btw", autoDeliver: false }),
    "btw",
  );
  assert.equal(
    resultDeliveryChannel({ origin: "btw", autoDeliver: true }),
    "btw",
  );
});

test("a result consumed by a later wait is not delivered", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    output: string;
  }>();

  delivery.defer({ id: "sa-1", output: "done" });
  delivery.consume(["sa-1"]);

  assert.deepEqual(delivery.drain(), []);
});

test("unconsumed results are delivered once in settlement order", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const first = { id: "sa-1" };
  const second = { id: "sa-2" };

  delivery.defer(first);
  delivery.defer(second);

  assert.deepEqual(delivery.drain(), [first, second]);
  assert.deepEqual(delivery.drain(), []);
});
