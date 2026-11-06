import test from "node:test";
import assert from "node:assert/strict";
import { extractMetricValue, objectValue } from "./marketEvidenceMetrics.js";

test("evidence metric path reads nested object properties", () => {
  assert.equal(objectValue({ market_data: { current_price: { usd: 123.45 } } }, "market_data.current_price.usd"), 123.45);
});

test("evidence metric path returns null for missing or unsafe paths", () => {
  assert.equal(objectValue({ market_data: {} }, "market_data.current_price.usd"), null);
  assert.equal(objectValue({ a: 1 }, "a.__proto__"), null);
  assert.equal(objectValue({ a: 1 }, ""), null);
});


test("GDELT article count returns zero for an empty result list", () => {
  assert.equal(extractMetricValue("gdelt", { articles: [] }, "articles.length"), 0);
});

test("GDELT article count returns the number of indexed articles", () => {
  assert.equal(extractMetricValue("gdelt", { articles: [{ title: "A" }, { title: "B" }] }, "articles.length"), 2);
});

test("GDELT article count remains unavailable when the response omits articles", () => {
  assert.equal(extractMetricValue("gdelt", { message: "no article data" }, "articles.length"), null);
});

test("DeFiLlama scalar TVL response is extracted for the tvl metric", () => {
  assert.equal(extractMetricValue("defillama", 1250000.5, "tvl"), 1250000.5);
});

test("DeFiLlama TVL extraction rejects non-finite scalar values", () => {
  assert.equal(extractMetricValue("defillama", Number.NaN, "tvl"), null);
  assert.equal(extractMetricValue("defillama", "1250000", "tvl"), null);
});

test("provider-aware extraction retains normal nested metric lookup", () => {
  assert.equal(extractMetricValue("coingecko", { market_data: { current_price: { usd: 123.45 } } }, "market_data.current_price.usd"), 123.45);
});
