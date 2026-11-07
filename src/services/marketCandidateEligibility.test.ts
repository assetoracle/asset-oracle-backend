import test from "node:test";
import assert from "node:assert/strict";
import { validateCandidateForPromotion } from "./marketCandidateEligibility.js";

const now = Date.parse("2026-11-07T12:00:00.000Z");
const proposal = (closesAt: string) => ({
  question: "Will BTC/USD exceed 100000 USD at resolution?",
  description: "Resolve using the configured CoinGecko BTC/USD observation.",
  category: "Digital Assets",
  closesAt,
  resolvesAt: "2026-11-07T14:00:00.000Z",
  resolutionRule: {
    sourceId: "coingecko",
    metric: "BTC/USD",
    comparison: "ABOVE",
    targetValue: 100000,
    currency: "USD",
    observationTime: "2026-11-07T12:00:00.000Z",
    description: "Use the CoinGecko BTC/USD value at the observation time.",
    query: { coinId: "bitcoin" },
  },
});

test("rejects candidates whose closing time has passed", () => {
  const result = validateCandidateForPromotion(proposal("2026-11-07T11:59:59.000Z"), "Digital Assets", now);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /expired/i);
});

test("rejects candidates closing exactly at the decision time", () => {
  const result = validateCandidateForPromotion(proposal("2026-11-07T12:00:00.000Z"), "Digital Assets", now);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /expired/i);
});

test("accepts a valid candidate with a future closing time", () => {
  const result = validateCandidateForPromotion(proposal("2026-11-07T13:00:00.000Z"), "Digital Assets", now);
  assert.equal(result.valid, true);
});

test("rejects a category mismatch", () => {
  const result = validateCandidateForPromotion(proposal("2026-11-07T13:00:00.000Z"), "RWA", now);
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /category/i);
});

test("rejects a candidate with an invalid resolution schedule", () => {
  const result = validateCandidateForPromotion({
    ...proposal("2026-11-07T13:00:00.000Z"),
    resolvesAt: "2026-11-07T12:30:00.000Z",
  }, "Digital Assets", now);
  assert.equal(result.valid, false);
});
