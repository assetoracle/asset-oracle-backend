import { strict as assert } from "node:assert";
import test from "node:test";
import { selectProvidersForMarket } from "./marketProviderRouter.js";

test("selects only digital asset providers for Digital Assets markets", () => {
  assert.deepEqual(selectProvidersForMarket({ category: "Digital Assets" }), ["coingecko", "dexscreener"]);
});

test("selects only RWA providers for RWA markets", () => {
  assert.deepEqual(selectProvidersForMarket({ category: "RWA" }), ["defillama", "dexscreener"]);
});

test("selects only sports providers for Sports markets", () => {
  assert.deepEqual(selectProvidersForMarket({ category: "Sports" }), ["sportmonks", "api-football"]);
});

test("selects only economic providers for Economics markets", () => {
  assert.deepEqual(selectProvidersForMarket({ category: "Economics" }), ["fred", "world-bank"]);
});

test("selects only regional providers for Regional markets", () => {
  assert.deepEqual(selectProvidersForMarket({ category: "Regional" }), ["gdelt", "open-meteo"]);
});

test("a market sourceId narrows execution to one approved provider", () => {
  assert.deepEqual(selectProvidersForMarket({ category: "RWA", sourceId: "defillama" }), ["defillama"]);
});

test("rejects providers outside the market category allowlist", () => {
  assert.throws(() => selectProvidersForMarket({ category: "RWA", sourceId: "coingecko" }), /not approved/);
  assert.throws(() => selectProvidersForMarket({ category: "Sports", sourceId: "fred" }), /not approved/);
});
