import { strict as assert } from "node:assert";
import test from "node:test";
import {
  getConfiguredProviders,
  getMarketDataRotationSlot,
  MARKET_DATA_ROTATION,
} from "./marketDataRotation.js";

test("rotates through the five categories in the agreed order", () => {
  const start = new Date("2026-11-03T00:00:00.000Z");
  const first = getMarketDataRotationSlot(start);
  const second = getMarketDataRotationSlot(new Date(start.getTime() + 10 * 60_000));
  const third = getMarketDataRotationSlot(new Date(start.getTime() + 20 * 60_000));
  const fourth = getMarketDataRotationSlot(new Date(start.getTime() + 30 * 60_000));
  const fifth = getMarketDataRotationSlot(new Date(start.getTime() + 40 * 60_000));
  const sixth = getMarketDataRotationSlot(new Date(start.getTime() + 50 * 60_000));

  assert.deepEqual(
    [first.category.key, second.category.key, third.category.key, fourth.category.key, fifth.category.key, sixth.category.key],
    ["rwa", "digital-assets", "economic-financial", "regional-global-events", "sports", "rwa"],
  );
});

test("resolves the same slot regardless of worker restart", () => {
  const instant = new Date("2026-11-03T12:34:00.000Z");
  assert.deepEqual(getMarketDataRotationSlot(instant), getMarketDataRotationSlot(new Date(instant)));
});

test("returns slot boundaries aligned to UTC ten-minute intervals", () => {
  const slot = getMarketDataRotationSlot(new Date("2026-11-03T12:34:56.000Z"));
  assert.equal(slot.slotStartedAt, "2026-11-03T12:30:00.000Z");
  assert.equal(slot.nextSlotAt, "2026-11-03T12:40:00.000Z");
});

test("filters out providers that are not configured yet", () => {
  assert.deepEqual(
    getConfiguredProviders("digital-assets", ["coingecko", "dexscreener"]),
    ["coingecko", "dexscreener"],
  );
  assert.deepEqual(getConfiguredProviders("sports", []), []);
});

test("exposes all five categories in the agreed order", () => {
  assert.deepEqual(MARKET_DATA_ROTATION.map((item) => item.key), [
    "rwa",
    "digital-assets",
    "economic-financial",
    "regional-global-events",
    "sports",
  ]);
});

test("rejects an invalid date", () => {
  assert.throws(() => getMarketDataRotationSlot(new Date("invalid")), /valid date/);
});
