import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketScanIds, orderMarketIdsFromCursor, nextMarketCursor } from "./marketLifecycleScheduling.js";

test("scans at most the configured limit and continues from a saved cursor", () => {
  assert.deepEqual(buildMarketScanIds(1200, 501, 500), Array.from({ length: 500 }, (_, i) => i + 501));
});

test("wraps market scans at the final market without skipping IDs", () => {
  assert.deepEqual(buildMarketScanIds(5, 4, 4), [4, 5, 1, 2]);
});

test("scans every market when the total is below the limit", () => {
  assert.deepEqual(buildMarketScanIds(3, 2, 500), [2, 3, 1]);
});

test("orders payout candidates from a persistent cursor across the full market range", () => {
  assert.deepEqual(orderMarketIdsFromCursor([501, 502, 503, 504], 503, 1200), [503, 504, 501, 502]);
});

test("moves payout cursor past the last processed market and wraps", () => {
  assert.equal(nextMarketCursor(502, 1200), 503);
  assert.equal(nextMarketCursor(1200, 1200), 1);
});

test("handles an empty market set safely", () => {
  assert.deepEqual(buildMarketScanIds(0, 1, 500), []);
  assert.deepEqual(orderMarketIdsFromCursor([], 1, 0), []);
  assert.equal(nextMarketCursor(1, 0), 1);
});
