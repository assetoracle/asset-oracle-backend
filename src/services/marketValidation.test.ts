import test from "node:test";
import assert from "node:assert/strict";
import { marketProposalSchema } from "./marketValidation.js";

function validProposal(comparison: string = "AT_LEAST") {
  const closesAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const resolvesAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  return {
    question: "Will Bitcoin reach $100,000 by November?",
    description: "This market resolves YES if the approved BTC/USD source records the threshold.",
    category: "Digital Assets",
    closesAt,
    resolvesAt,
    resolutionRule: {
      sourceId: "coingecko",
      query: { coinId: "bitcoin", vsCurrency: "usd" },
      metric: "price_usd",
      comparison,
      targetValue: 100000,
      currency: "USD",
      observationTime: resolvesAt,
      description: "YES if the approved BTC/USD source records at least $100,000.",
    },
  };
}

test("market proposal schema accepts inclusive AT_LEAST comparison", () => {
  const parsed = marketProposalSchema.safeParse(validProposal("AT_LEAST"));
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.resolutionRule.comparison, "AT_LEAST");
    assert.equal(parsed.data.resolutionRule.targetValue, 100000);
  }
});

test("market proposal schema rejects unsupported comparison values", () => {
  const parsed = marketProposalSchema.safeParse(validProposal("GREATER_OR_EQUAL"));
  assert.equal(parsed.success, false);
});

test("market proposal schema requires resolution after closing", () => {
  const proposal = validProposal();
  proposal.resolvesAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const parsed = marketProposalSchema.safeParse(proposal);
  assert.equal(parsed.success, false);
});

test("sports markets are rejected while the Sports provider route is disabled", () => {
  const base = validProposal();
  const proposal = {
    ...base,
    category: "Sports",
    sport: "football",
    resolutionRule: {
      ...base.resolutionRule,
      sourceId: "sportmonks",
      metric: "data.length",
      query: { date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10) },
    },
  };
  assert.equal(marketProposalSchema.safeParse(proposal).success, false);
});

test("non-sports markets reject a sport selection", () => {
  assert.equal(marketProposalSchema.safeParse({ ...validProposal(), sport: "football" }).success, false);
});

test("market proposals reject providers whose category is disabled", () => {
  const cases = [
    { category: "RWA", sourceId: "defillama", metric: "tvl", query: { protocol: "ondo-finance" } },
    { category: "Regional", sourceId: "gdelt", metric: "articles.length", query: { search: "Nigeria flood", timespan: "24h", requiredTerms: ["Nigeria", "flood"] } },
    { category: "Sports", sourceId: "sportmonks", metric: "data.length", query: { date: "2026-11-20" }, sport: "football" },
    { category: "Economics", sourceId: "fred", metric: "observations.0.value", query: { seriesId: "CPIAUCSL" } },
    { category: "Digital Assets", sourceId: "dexscreener", metric: "priceUsd", query: { search: "bitcoin" } },
  ];
  for (const item of cases) {
    const base = validProposal();
    const proposal = {
      ...base,
      category: item.category,
      ...(item.sport ? { sport: item.sport } : {}),
      resolutionRule: { ...base.resolutionRule, sourceId: item.sourceId, metric: item.metric, query: item.query },
    };
    assert.equal(marketProposalSchema.safeParse(proposal).success, false, `${item.category}/${item.sourceId} should be disabled`);
  }
});

test("market proposals accept World Bank for Economics", () => {
  const base = validProposal();
  const proposal = {
    ...base,
    category: "Economics",
    resolutionRule: {
      ...base.resolutionRule,
      sourceId: "world-bank",
      metric: "1.0.value",
      query: { country: "NGA", indicator: "FP.CPI.TOTL.ZG" },
    },
  };
  assert.equal(marketProposalSchema.safeParse(proposal).success, true);
});

test("market proposals require provider-specific query parameters", () => {
  const proposal = validProposal();
  proposal.resolutionRule.query.coinId = "";
  assert.equal(marketProposalSchema.safeParse(proposal).success, false);
});

test("market proposals reject metrics not supported by their selected provider", () => {
  const proposal = validProposal();
  proposal.resolutionRule.metric = "response.length";
  assert.equal(marketProposalSchema.safeParse(proposal).success, false);
});
