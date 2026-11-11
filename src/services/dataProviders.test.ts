import { strict as assert } from "node:assert";
import test from "node:test";
import {
  apiFootballFixtures,
  coingeckoHistoricalPrice,
  coingeckoMarkets,
  dexscreenerSearch,
  dexscreenerTokenPairs,
  defiLlamaProtocolTvl,
  fredObservations,
  gdeltArticles,
  gdeltArticlesInWindow,
  openMeteoHistorical,
  ProviderRateLimitError,
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

test("validates FRED series identifiers, date range and units", () => {
  assert.throws(() => fredObservations("bad series id"), /Invalid FRED series ID/);
  assert.throws(() => fredObservations("GDP", "2026-02-01", "2026-01-01"), /Invalid FRED date range/);
  assert.throws(() => fredObservations("GDP", undefined, undefined, "invalid"), /Invalid FRED observation units/);
});

test("FRED requests the newest observation only and supports year-over-year percent change", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FRED_API_KEY;
  let requestedUrl = "";
  process.env.FRED_API_KEY = "test-fred-key";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ observations: [{ date: "2026-10-01", value: "3.1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fredObservations("CPIAUCSL", undefined, undefined, "pc1");
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("series_id"), "CPIAUCSL");
    assert.equal(url.searchParams.get("sort_order"), "desc");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("units"), "pc1");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = originalKey;
  }
});


test("CoinGecko historical price uses the observation timestamp and selects the latest point not after it", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COINGECKO_API_KEY;
  const observedAt = Date.parse("2026-11-07T05:01:01.000Z");
  let requestedUrl = "";
  process.env.COINGECKO_API_KEY = "test-key";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ prices: [[observedAt - 120_000, 73100], [observedAt + 30_000, 74000]] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await coingeckoHistoricalPrice("bitcoin", "usd", "2026-11-07T05:01:01.000Z");
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/api/v3/coins/bitcoin/market_chart/range");
    assert.equal(Number(url.searchParams.get("from")), Math.floor((observedAt - 60 * 60_000) / 1000));
    assert.equal(result.data.market_data.current_price.usd, 73100);
    assert.equal(result.data.historical_observation_time, new Date(observedAt - 120_000).toISOString());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COINGECKO_API_KEY;
    else process.env.COINGECKO_API_KEY = originalKey;
  }
});

test("CoinGecko historical price fails closed when no point exists at or before observation time", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COINGECKO_API_KEY;
  process.env.COINGECKO_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({ prices: [[Date.now() + 60_000, 90000]] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    await assert.rejects(() => coingeckoHistoricalPrice("bitcoin", "usd", new Date(Date.now() - 10_000).toISOString()), /sufficiently close historical price/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COINGECKO_API_KEY;
    else process.env.COINGECKO_API_KEY = originalKey;
  }
});

test("GDELT uses explicit observation-window bounds and filters out-of-window articles", async () => {
  const originalFetch = globalThis.fetch;
  const start = "2026-11-06T12:00:00.000Z";
  const end = "2026-11-07T12:00:00.000Z";
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ articles: [
      { seendate: "20261106T120000Z", title: "start inclusive" },
      { seendate: "20261107T115900Z", title: "inside" },
      { seendate: "20261107T120100Z", title: "after window" },
      { title: "missing timestamp" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await gdeltArticlesInWindow("Nigeria flood", 100, start, end);
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get("startdatetime"), "20261106120000Z");
    assert.equal(url.searchParams.get("enddatetime"), "20261107120000Z");
    assert.deepEqual(result.data.articles.map((article) => article.title), ["start inclusive", "inside"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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


test("provider requests retry once after a transient network failure", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) throw new TypeError("temporary network failure");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await dexscreenerSearch("asset chain");
    assert.deepEqual(result.data, { ok: true });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider requests retry one transient HTTP 503 response", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await dexscreenerSearch("asset chain");
    assert.deepEqual(result.data, { ok: true });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("GDELT rate limits respect Retry-After and retry within a bounded budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  let attempts = 0;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number) => {
    delays.push(Number(timeout ?? 0));
    return originalSetTimeout(handler, 0);
  }) as typeof setTimeout;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "3" } });
    return new Response(JSON.stringify({ articles: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await gdeltArticles('"Nigeria" flood', 25, "24h");
    assert.deepEqual(result.data, { articles: [] });
    assert.equal(attempts, 2);
    assert.ok(delays.includes(3_000));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("GDELT rate-limit retries are bounded when Retry-After is excessive", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  let attempts = 0;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number) => {
    delays.push(Number(timeout ?? 0));
    return originalSetTimeout(handler, 0);
  }) as typeof setTimeout;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
  }) as typeof fetch;
  try {
    await assert.rejects(() => gdeltArticles('"Nigeria" flood', 25, "24h"), (error: unknown) => error instanceof ProviderRateLimitError && error.status === 429);
    assert.equal(attempts, 3);
    assert.ok(delays.includes(10_000));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
