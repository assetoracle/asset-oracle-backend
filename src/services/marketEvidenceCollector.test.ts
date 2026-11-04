import test from "node:test";
import assert from "node:assert/strict";
import { objectValue } from "./marketEvidenceMetrics.js";

test("evidence metric path reads nested object properties", () => {
  assert.equal(objectValue({ market_data: { current_price: { usd: 123.45 } } }, "market_data.current_price.usd"), 123.45);
});

test("evidence metric path reads array indexes", () => {
  assert.equal(objectValue({ observations: [{ value: "12.3" }] }, "observations[0].value"), "12.3");
});

test("evidence metric path returns null for missing or unsafe paths", () => {
  assert.equal(objectValue({ market_data: {} }, "market_data.current_price.usd"), null);
  assert.equal(objectValue({ a: 1 }, "a.__proto__"), null);
  assert.equal(objectValue({ a: 1 }, ""), null);
});
