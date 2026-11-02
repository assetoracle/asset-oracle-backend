import { strict as assert } from "node:assert";
import test from "node:test";
import {
  dexscreenerSearch,
  dexscreenerTokenPairs,
  defiLlamaProtocolTvl,
  footballMatches,
  fredObservations,
  gdeltArticles,
} from "./dataProviders.js";

test("rejects empty or oversized DexScreener search queries", () => {
  assert.throws(() => dexscreenerSearch(""), /Invalid token search query/);
  assert.throws(() => dexscreenerSearch("x".repeat(121)), /Invalid token search query/);
});

test("requires an exact token address and valid chain for DexScreener", () => {
  assert.throws(() => dexscreenerTokenPairs("bad chain!", "0x0000000000000000000000000000000000000000"), /Invalid chain or token address/);
  assert.throws(() => dexscreenerTokenPairs("ethereum", "USDC"), /Invalid chain or token address/);
});

test("rejects malformed DeFiLlama protocol slugs", () => {
  assert.throws(() => defiLlamaProtocolTvl("../protocol"), /Invalid protocol slug/);
});

test("validates football competition codes before requiring credentials", () => {
  assert.throws(() => footballMatches("Premier League"), /Invalid competition code/);
});

test("validates FRED series identifiers before requiring credentials", () => {
  assert.throws(() => fredObservations("bad series id"), /Invalid FRED series ID/);
});

test("validates GDELT query size and record limits", () => {
  assert.throws(() => gdeltArticles(""), /Invalid GDELT query/);
  assert.throws(() => gdeltArticles("election", 251), /Invalid GDELT query/);
});
