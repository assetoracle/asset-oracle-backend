import test from "node:test";
import assert from "node:assert/strict";
import { meanTickFromCumulatives, priceAtTick } from "./shalomDexMonitor.js";

test("meanTickFromCumulatives computes the arithmetic mean tick", () => {
  assert.equal(meanTickFromCumulatives(100n, 700n, 300), 2);
});

test("meanTickFromCumulatives rounds negative non-integral means down", () => {
  assert.equal(meanTickFromCumulatives(0n, -301n, 300), -2);
});

test("meanTickFromCumulatives rejects invalid windows", () => {
  assert.throws(() => meanTickFromCumulatives(0n, 1n, 0), /positive integer/);
});

test("priceAtTick applies token decimal adjustment", () => {
  assert.equal(priceAtTick(0, 18, 6), 1_000_000_000_000);
});

test("priceAtTick rejects impossible tick values", () => {
  assert.throws(() => priceAtTick(900_000, 18, 18), /Invalid tick/);
});
