import { strict as assert } from "node:assert";
import test from "node:test";
import {
  dexscreenerSearch, dexscreenerTokenPairs, defiLlamaProtocolTvl,
  coinGeckoCoin, sportmonksFixtures, apiFootballFixtures,
  fredObservations, worldBankIndicator, gdeltArticles, openMeteoForecast,
} from "./dataProviders.js";

test("validates DexScreener queries and token addresses", () => {
  assert.throws(() => dexscreenerSearch(""), /Invalid token search query/);
  assert.throws(() => dexscreenerSearch("x".repeat(121)), /Invalid token search query/);
  assert.throws(() => dexscreenerTokenPairs("bad chain!", "0x0000000000000000000000000000000000000000"), /Invalid chain or token address/);
  assert.throws(() => dexscreenerTokenPairs("ethereum", "USDC"), /Invalid chain or token address/);
});
test("validates DeFiLlama protocol slugs", () => {
  assert.throws(() => defiLlamaProtocolTvl("../protocol"), /Invalid protocol slug/);
});
test("validates CoinGecko parameters before requiring a key", () => {
  assert.throws(() => coinGeckoCoin("../bitcoin"), /Invalid CoinGecko coin/);
  assert.throws(() => coinGeckoCoin("bitcoin", "usd", 400), /Invalid CoinGecko coin/);
});
test("validates Sportmonks dates before requiring a token", () => {
  assert.throws(() => sportmonksFixtures("tomorrow"), /Invalid fixture date/);
});
test("validates API-Football parameters before requiring a key", () => {
  assert.throws(() => apiFootballFixtures("tomorrow"), /Invalid API-Football fixture parameters/);
  assert.throws(() => apiFootballFixtures("2026-01-01", 0), /Invalid API-Football fixture parameters/);
});
test("validates FRED series identifiers before requiring credentials", () => {
  assert.throws(() => fredObservations("bad series id"), /Invalid FRED series ID/);
});
test("validates World Bank country and indicator", () => {
  assert.throws(() => worldBankIndicator("Nigeria", "NY.GDP.MKTP.CD"), /Invalid World Bank country/);
  assert.throws(() => worldBankIndicator("NG", "../GDP"), /Invalid World Bank country/);
});
test("validates GDELT query size and record limits", () => {
  assert.throws(() => gdeltArticles(""), /Invalid GDELT query/);
  assert.throws(() => gdeltArticles("event", 251), /Invalid GDELT query/);
});
test("validates Open-Meteo coordinates and forecast range", () => {
  assert.throws(() => openMeteoForecast(91, 3), /Invalid Open-Meteo coordinates/);
  assert.throws(() => openMeteoForecast(6.5, 3.3, 20), /Invalid Open-Meteo coordinates/);
});
