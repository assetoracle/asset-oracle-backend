import { strict as assert } from "node:assert";
import test from "node:test";
import {
  apiFootballFixtures,
  coingeckoMarkets,
  dexscreenerSearch,
  dexscreenerTokenPairs,
  defiLlamaProtocolTvl,
  fredObservations,
  gdeltArticles,
  openMeteoHistorical,
  sportmonksFixturesByDate,
  worldBankIndicator,
} from "./dataProviders.js";

test("rejects invalid DexScreener search queries", () => {
  assert.throws(() => dexscreenerSearch(""), /Invalid token search query/);
  assert.throws(() => dexscreenerSearch("x".repeat(121)), /Invalid token search query/);
});

test("requires exact chain and token address for DexScreener", () => {
  assert.throws(() => dexscreenerTokenPairs("bad chain!", "0x0000000000000000000000000000000000000000"), /Invalid chain or token address/);
  assert.throws(() => dexscreenerTokenPairs("ethereum", "USDC"), /Invalid chain or token address/);
});

test("rejects malformed DeFiLlama protocol slugs", () => {
  assert.throws(() => defiLlamaProtocolTvl("../protocol"), /Invalid protocol slug/);
});

test("validates CoinGecko pagination and currency before checking credentials", () => {
  assert.throws(() => coingeckoMarkets("usd", 0), /Invalid CoinGecko market query/);
  assert.throws(() => coingeckoMarkets("usd", 1, 251), /Invalid CoinGecko market query/);
});

test("validates World Bank country and indicator identifiers", () => {
  assert.throws(() => worldBankIndicator("Nigeria", "NY.GDP.MKTP.CD"), /Invalid World Bank country or indicator query/);
  assert.throws(() => worldBankIndicator("NG", "../bad"), /Invalid World Bank country or indicator query/);
});

test("validates Open-Meteo coordinates and chronological date range", () => {
  assert.throws(() => openMeteoHistorical(91, 3, "2026-01-01", "2026-01-02"), /Invalid Open-Meteo coordinates or date range/);
  assert.throws(() => openMeteoHistorical(6.5, 3.3, "2026-02-01", "2026-01-01"), /Invalid Open-Meteo coordinates or date range/);
});

test("validates Sportmonks fixture date before checking credentials", () => {
  assert.throws(() => sportmonksFixturesByDate("not-a-date"), /Invalid Sportmonks fixture date/);
});

test("validates API-Football fixture filters before checking credentials", () => {
  assert.throws(() => apiFootballFixtures("2026-01-01", 0), /Invalid API-Football fixture query/);
  assert.throws(() => apiFootballFixtures("bad-date"), /Invalid API-Football fixture query/);
});

test("validates FRED series identifiers and date range", () => {
  assert.throws(() => fredObservations("bad series id"), /Invalid FRED series ID/);
  assert.throws(() => fredObservations("GDP", "2026-02-01", "2026-01-01"), /Invalid FRED date range/);
});


test("GDELT requests include the configured rolling timespan and result limit", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ articles: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await gdeltArticles('"Nigeria" flood', 100, "24h");
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("timespan"), "24h");
    assert.equal(url.searchParams.get("maxrecords"), "100");
    assert.equal(url.searchParams.get("mode"), "ArtList");
    assert.equal(url.searchParams.get("format"), "json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validates GDELT query size and record limits", () => {
  assert.throws(() => gdeltArticles(""), /Invalid GDELT query/);
  assert.throws(() => gdeltArticles("regional event", 251), /Invalid GDELT query or timespan/);
  assert.throws(() => gdeltArticles("regional event", 25, "whenever"), /Invalid GDELT query or timespan/);
});
