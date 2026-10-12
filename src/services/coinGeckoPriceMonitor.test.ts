import test from "node:test";
import assert from "node:assert/strict";
import { parseCoinGeckoObservation } from "./coinGeckoPricing.js";

test("parses fresh BTC price and timestamp", () => {
  const checkedAt = new Date("2026-10-12T12:00:00.000Z");
  const parsed = parseCoinGeckoObservation(
    "bitcoin",
    { usd: 100000, usd_market_cap: 1_900_000_000_000, last_updated_at: checkedAt.getTime() / 1000 },
    checkedAt,
  );
  assert.equal(parsed.priceUsd, 100000);
  assert.equal(parsed.symbol, "BTC");
  assert.equal(parsed.sourceUpdatedAt, checkedAt.toISOString());
});

test("rejects stale source observations", () => {
  const checkedAt = new Date("2026-10-12T12:10:00.000Z");
  assert.throws(
    () => parseCoinGeckoObservation("ethereum", {
      usd: 4000,
      last_updated_at: new Date("2026-10-12T12:00:00.000Z").getTime() / 1000,
    }, checkedAt),
    /stale/,
  );
});

test("rejects future source timestamps beyond permitted clock skew", () => {
  const checkedAt = new Date("2026-10-12T12:00:00.000Z");
  assert.throws(
    () => parseCoinGeckoObservation("binancecoin", {
      usd: 1000,
      last_updated_at: new Date("2026-10-12T12:02:00.000Z").getTime() / 1000,
    }, checkedAt),
    /future/,
  );
});

test("rejects missing or invalid prices", () => {
  const checkedAt = new Date("2026-10-12T12:00:00.000Z");
  assert.throws(
    () => parseCoinGeckoObservation("bitcoin", { usd: 0, last_updated_at: checkedAt.getTime() / 1000 }, checkedAt),
    /valid BTC price/,
  );
});
