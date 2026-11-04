import { strict as assert } from "node:assert";
import test from "node:test";
import { marketProposalSchema } from "./marketValidation.js";

test("generated candidate proposal requires future close and later resolution", () => {
  const now = Date.now();
  const proposal = {
    question: "Will Bitcoin trade above 100000 USD?",
    description: "This candidate resolves using the configured CoinGecko market data at the observation time.",
    category: "Crypto",
    closesAt: new Date(now + 60 * 60_000).toISOString(),
    resolvesAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    resolutionRule: {
      sourceId: "coingecko",
      metric: "market_data.current_price.usd",
      comparison: "ABOVE",
      targetValue: 100000,
      currency: "USD",
      observationTime: new Date(now).toISOString(),
      description: "Resolve using the CoinGecko current USD price at the specified observation time.",
      query: { coinId: "bitcoin", vsCurrency: "usd" },
    },
  };
  assert.equal(marketProposalSchema.safeParse(proposal).success, true);
});

test("candidate validation rejects a provider outside its category", () => {
  const now = Date.now();
  const result = marketProposalSchema.safeParse({
    question: "Will Bitcoin trade above 100000 USD?",
    description: "This candidate resolves using a configured market data source.",
    category: "Crypto",
    closesAt: new Date(now + 60 * 60_000).toISOString(),
    resolvesAt: new Date(now + 2 * 60 * 60_000).toISOString(),
    resolutionRule: {
      sourceId: "fred",
      metric: "value",
      comparison: "ABOVE",
      targetValue: 100000,
      observationTime: new Date(now).toISOString(),
      description: "Resolve using the configured data source at the observation time.",
      query: { seriesId: "CPIAUCSL" },
    },
  });
  assert.equal(result.success, false);
});
