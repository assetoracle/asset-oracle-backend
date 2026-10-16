import test from "node:test";
import assert from "node:assert/strict";
import { CoinGeckoProvider, ProviderRequestError } from "./coingeckoProvider.js";

const recentTimestamp = Math.floor(Date.now() / 1000) - 30;

test("CoinGecko provider normalizes valid USD prices and deduplicates requested IDs", async () => {
  let requestedUrl = "";
  const provider = new CoinGeckoProvider({
    fetchImpl: (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        bitcoin: { usd: 65000, last_updated_at: recentTimestamp },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const result = await provider.getUsdPrices(["bitcoin", "bitcoin"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].assetId, "bitcoin");
  assert.equal(result[0].value, 65000);
  assert.equal(result[0].currency, "USD");
  assert.equal(new URL(requestedUrl).searchParams.get("ids"), "bitcoin");
});

test("CoinGecko provider rejects invalid asset IDs without making a request", async () => {
  let called = false;
  const provider = new CoinGeckoProvider({
    fetchImpl: (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(provider.getUsdPrices(["bitcoin,ethereum"]), ProviderRequestError);
  assert.equal(called, false);
});

test("CoinGecko provider marks rate-limit responses retryable", async () => {
  const provider = new CoinGeckoProvider({
    fetchImpl: (async () => new Response("rate limited", { status: 429 })) as typeof fetch,
  });
  await assert.rejects(provider.getUsdPrices(["bitcoin"]), (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("CoinGecko provider omits stale or malformed observations", async () => {
  const provider = new CoinGeckoProvider({
    fetchImpl: (async () => new Response(JSON.stringify({
      bitcoin: { usd: 65000, last_updated_at: recentTimestamp - 3600 },
      ethereum: { usd: -1, last_updated_at: recentTimestamp },
      solana: { usd: 150 },
    }), { status: 200 })) as typeof fetch,
  });
  const result = await provider.getUsdPrices(["bitcoin", "ethereum", "solana"]);
  assert.equal(result.length, 0);
});
