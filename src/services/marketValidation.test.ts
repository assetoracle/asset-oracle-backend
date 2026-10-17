import test from "node:test";
import assert from "node:assert/strict";
import { marketProposalSchema } from "./marketValidation.js";

function validProposal(comparison: string = "AT_LEAST") {
  const closesAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const resolvesAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  return {
    question: "Will Bitcoin reach $100,000 by November?",
    description: "This market resolves YES if the approved BTC/USD source records the threshold.",
    category: "Crypto",
    closesAt,
    resolvesAt,
    resolutionRule: {
      sourceId: "coingecko",
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


test("sports markets require a supported sport", () => {
  const proposal = { ...validProposal(), category: "Sports" };
  assert.equal(marketProposalSchema.safeParse(proposal).success, false);
  for (const sport of ["football", "basketball", "tennis"] as const) {
    assert.equal(marketProposalSchema.safeParse({ ...proposal, sport }).success, true);
  }
});

test("non-sports markets reject a sport selection", () => {
  assert.equal(marketProposalSchema.safeParse({ ...validProposal(), sport: "football" }).success, false);
});
