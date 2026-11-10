import test from "node:test";
import assert from "node:assert/strict";
import { validateCandidateForPromotion } from "./marketCandidateEligibility.js";

const now = Date.now();
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const proposal = (closesAt: string) => ({
  question: "Will BTC/USD exceed 100000 USD at resolution?",
  description: "Resolve using the configured CoinGecko BTC/USD observation.",
  category: "Digital Assets",
  closesAt,
  resolvesAt: at(2 * 60 * 60 * 1000),
  resolutionRule: {
    sourceId: "coingecko",
    metric: "BTC/USD",
    comparison: "ABOVE",
    targetValue: 100000,
    currency: "USD",
    observationTime: at(0),
    description: "Use the CoinGecko BTC/USD value at the observation time.",
    query: { coinId: "bitcoin" },
  },
});

test("rejects candidates whose closing time has passed", () => {
  const result = validateCandidateForPromotion(proposal(at(-1)), "Digital Assets", now);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /expired/i);
});

test("rejects candidates closing exactly at the decision time", () => {
  const result = validateCandidateForPromotion(proposal(at(0)), "Digital Assets", now);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /expired/i);
});

test("accepts a valid candidate with a future closing time", () => {
  const result = validateCandidateForPromotion(proposal(at(60 * 60 * 1000)), "Digital Assets", now);
  assert.equal(result.valid, true);
});

test("rejects a category mismatch", () => {
  const result = validateCandidateForPromotion(proposal(at(60 * 60 * 1000)), "RWA", now);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /category/i);
});

test("rejects a candidate with an invalid resolution schedule", () => {
  const result = validateCandidateForPromotion({
    ...proposal(at(60 * 60 * 1000)),
    resolvesAt: at(30 * 60 * 1000),
  }, "Digital Assets", now);
  assert.equal(result.valid, false);
});
