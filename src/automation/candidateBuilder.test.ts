import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceThresholdCandidates } from "./candidateBuilder.js";
import type { ProviderEvidence } from "./types.js";

const now = new Date("2026-10-16T12:00:00.000Z");
const evidence: ProviderEvidence = {
  provider: "coingecko",
  metric: "price_usd",
  assetId: "bitcoin",
  observedAt: new Date(now.getTime() - 30_000).toISOString(),
  value: 100_000,
  currency: "USD",
  sourceUrl: "https://www.coingecko.com/en/coins/bitcoin",
};

test("candidate builder creates a validated, review-only proposal with deterministic key", () => {
  const result = buildPriceThresholdCandidates([evidence], { now: () => now });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.candidates[0].proposal.resolutionRule.targetValue, 105_000);
  assert.equal(result.candidates[0].proposal.category, "Crypto");
  assert.match(result.candidates[0].proposal.question, /Bitcoin \(BTC\).*2026-10-17 12:05:00 UTC/);
  assert.equal(result.candidates[0].proposal.resolutionRule.observationTime, result.candidates[0].proposal.resolvesAt);
  assert.match(result.candidates[0].proposal.resolutionRule.description, /leave unresolved for manual review/);
  assert.equal(result.candidates[0].quality.score, 70);
  const repeated = buildPriceThresholdCandidates([evidence], { now: () => now });
  assert.equal(repeated.candidates[0].key, result.candidates[0].key);
});

test("candidate builder rejects stale evidence", () => {
  const stale = { ...evidence, observedAt: new Date(now.getTime() - 20 * 60_000).toISOString() };
  const result = buildPriceThresholdCandidates([stale], { now: () => now });
  assert.equal(result.candidates.length, 0);
  assert.match(result.skipped[0].reason, /stale/);
});

test("candidate builder rejects unsupported provider metrics", () => {
  const unsupported = { ...evidence, provider: "unknown" };
  const result = buildPriceThresholdCandidates([unsupported], { now: () => now });
  assert.equal(result.candidates.length, 0);
  assert.match(result.skipped[0].reason, /Unsupported/);
});

test("candidate builder rejects invalid threshold configuration", () => {
  assert.throws(
    () => buildPriceThresholdCandidates([evidence], { thresholdPercent: 0, now: () => now }),
    /thresholdPercent/,
  );
});

test("candidate key stays stable for repeated observations on the same UTC day", () => {
  const laterObservation = {
    ...evidence,
    observedAt: new Date(now.getTime() - 10_000).toISOString(),
    value: 101_000,
  };
  const first = buildPriceThresholdCandidates([evidence], { now: () => now });
  const second = buildPriceThresholdCandidates([laterObservation], { now: () => now });
  assert.equal(first.candidates[0].key, second.candidates[0].key);
});

test("candidate key changes on a new UTC observation day", () => {
  const nextDayEvidence = {
    ...evidence,
    observedAt: "2026-10-17T11:59:30.000Z",
  };
  const first = buildPriceThresholdCandidates([evidence], { now: () => now });
  const nextDayNow = new Date("2026-10-17T12:00:00.000Z");
  const second = buildPriceThresholdCandidates([nextDayEvidence], { now: () => nextDayNow });
  assert.notEqual(first.candidates[0].key, second.candidates[0].key);
});
