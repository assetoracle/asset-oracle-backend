import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSettlementEvidence } from "./settlementEvaluator.js";
import type { ProviderEvidence } from "./types.js";

const target = "2026-10-17T12:00:00.000Z";
const now = new Date("2026-10-17T12:01:00.000Z");
const base: ProviderEvidence = {
  provider: "coingecko", metric: "price_usd", assetId: "bitcoin",
  observedAt: "2026-10-17T11:59:30.000Z", retrievedAt: "2026-10-17T12:00:00.000Z",
  value: 101, currency: "USD", sourceUrl: "https://www.coingecko.com/en/coins/bitcoin",
  rawResponse: { usd: 101 },
};
const rule = {
  sourceId: "coingecko", metric: "price_usd", targetValue: 100, currency: "USD",
  comparison: "AT_LEAST" as const, observationTime: target,
};

test("settlement evaluator returns deterministic outcome and evidence hash for eligible evidence", () => {
  const result = evaluateSettlementEvidence({ rule, assetId: "bitcoin", evidence: [base], toleranceSeconds: 60, now });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.outcome, "YES");
  assert.equal(result.value, 101);
  assert.match(result.evidenceHash, /^0x[0-9a-f]{64}$/);
});

test("settlement evaluator refuses missing or out-of-window evidence", () => {
  const result = evaluateSettlementEvidence({ rule, assetId: "bitcoin", evidence: [{ ...base, observedAt: "2026-10-17T11:50:00.000Z" }], toleranceSeconds: 60, now });
  assert.equal(result.status, "MANUAL_REVIEW");
});

test("settlement evaluator refuses evidence for a different asset or source", () => {
  const result = evaluateSettlementEvidence({ rule, assetId: "bitcoin", evidence: [{ ...base, assetId: "ethereum" }], toleranceSeconds: 60, now });
  assert.equal(result.status, "MANUAL_REVIEW");
});

test("settlement evaluator refuses conflicting outcomes inside the allowed window", () => {
  const second = { ...base, observedAt: "2026-10-17T12:00:30.000Z", value: 99, rawResponse: { usd: 99 } };
  const result = evaluateSettlementEvidence({ rule, assetId: "bitcoin", evidence: [base, second], toleranceSeconds: 60, now });
  assert.equal(result.status, "MANUAL_REVIEW");
  if (result.status === "MANUAL_REVIEW") assert.ok(result.evidenceHash);
});

test("settlement evaluator refuses to resolve before the observation time", () => {
  const result = evaluateSettlementEvidence({ rule, assetId: "bitcoin", evidence: [base], toleranceSeconds: 60, now: new Date("2026-10-17T11:59:00.000Z") });
  assert.equal(result.status, "MANUAL_REVIEW");
});
