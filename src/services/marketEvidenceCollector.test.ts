import test from "node:test";
import assert from "node:assert/strict";
import { extractMetricValue, isSupportedMetric, objectValue } from "./marketEvidenceMetrics.js";

test("evidence metric path reads nested object properties", () => {
  assert.equal(objectValue({ market_data: { current_price: { usd: 123.45 } } }, "market_data.current_price.usd"), 123.45);
});

test("evidence metric path returns null for missing or unsafe paths", () => {
  assert.equal(objectValue({ market_data: {} }, "market_data.current_price.usd"), null);
  assert.equal(objectValue({ a: 1 }, "a.__proto__"), null);
  assert.equal(objectValue({ a: 1 }, "a.constructor"), null);
  assert.equal(objectValue({ a: 1 }, ""), null);
});

test("legacy BTC/USD market metric maps to the CoinGecko USD price", () => {
  const response = { market_data: { current_price: { usd: 76543.21 } } };
  assert.equal(isSupportedMetric("coingecko", "BTC/USD"), true);
  assert.equal(extractMetricValue("coingecko", response, "BTC/USD"), 76543.21);
});

test("CoinGecko explicit price metric and configured quote-currency paths are supported", () => {
  const response = { market_data: { current_price: { usd: 76543.21, ngn: 112000000 } } };
  assert.equal(extractMetricValue("coingecko", response, "price_usd"), 76543.21);
  assert.equal(extractMetricValue("coingecko", response, "market_data.current_price.ngn"), 112000000);
  assert.equal(isSupportedMetric("coingecko", "market_data.current_price.ngn"), true);
});

test("GDELT metric counts only market-screened relevant articles", () => {
  assert.equal(extractMetricValue("gdelt", {
    articles: [{ title: "Nigeria leadership" }, { title: "Nigeria flood update" }],
    relevant_articles: [{ title: "Nigeria flood update" }],
  }, "articles.length"), 1);
  assert.equal(extractMetricValue("gdelt", {
    articles: [{ title: "Nigeria leadership" }],
  }, "articles.length"), null);
});

test("GDELT metric returns zero when relevance screening found no qualifying articles", () => {
  assert.equal(extractMetricValue("gdelt", { articles: [{ title: "Nigeria leadership" }], relevant_articles: [] }, "articles.length"), 0);
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

test("football provider fixture counts are extracted from their actual response arrays", () => {
  assert.equal(extractMetricValue("api-football", { response: [{ fixture: 1 }, { fixture: 2 }] }, "response.length"), 2);
  assert.equal(extractMetricValue("sportmonks", { data: [{ id: 1 }] }, "data.length"), 1);
  assert.equal(extractMetricValue("api-football", { response: null }, "response.length"), null);
});

test("provider metric registry rejects unsupported metrics before proposal approval", () => {
  assert.equal(isSupportedMetric("fred", "observations.0.value"), true);
  assert.equal(isSupportedMetric("world-bank", "1.0.value"), true);
  assert.equal(isSupportedMetric("fred", "BTC/USD"), false);
  assert.equal(isSupportedMetric("coingecko", "untrusted.expression"), false);
});

test("provider-aware extraction retains normal nested metric lookup", () => {
  assert.equal(extractMetricValue("coingecko", { market_data: { current_price: { usd: 123.45 } } }, "market_data.current_price.usd"), 123.45);
});
