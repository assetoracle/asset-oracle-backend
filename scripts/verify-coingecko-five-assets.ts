import { coingeckoHistoricalPrice } from "../src/services/dataProviders.js";

const assets = [
  { symbol: "BTC", name: "Bitcoin", coinId: "bitcoin" },
  { symbol: "ETH", name: "Ethereum", coinId: "ethereum" },
  { symbol: "BNB", name: "BNB", coinId: "binancecoin" },
  { symbol: "SOL", name: "Solana", coinId: "solana" },
  { symbol: "XRP", name: "XRP", coinId: "ripple" },
] as const;

if (!process.env.COINGECKO_API_KEY?.trim()) {
  throw new Error("COINGECKO_API_KEY is not configured in this workflow.");
}

const observationTime = new Date(Date.now() - 10 * 60_000).toISOString();
const failures: string[] = [];

console.log(`Read-only CoinGecko historical verification`);
console.log(`Requested observation time: ${observationTime}`);
console.log("No database, market, or evidence-store operations are performed.");

for (const asset of assets) {
  try {
    const result = await coingeckoHistoricalPrice(asset.coinId, "usd", observationTime);
    const data = result.data as {
      market_data?: { current_price?: { usd?: number } };
      historical_observation_time?: string;
      requested_observation_time?: string;
    };
    const price = data.market_data?.current_price?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error("Historical USD price was missing or invalid.");
    }
    console.log(`PASS ${asset.symbol} (${asset.coinId}): USD ${price} at ${data.historical_observation_time}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error";
    failures.push(`${asset.symbol}: ${message}`);
    console.error(`FAIL ${asset.symbol} (${asset.coinId}): ${message}`);
  }
}

if (failures.length > 0) {
  throw new Error(`CoinGecko verification failed for ${failures.length} of ${assets.length} assets.`);
}

console.log(`SUCCESS: all ${assets.length} selected assets returned valid historical USD prices.`);
