import { createHash } from "node:crypto";
import type { ProviderEvidence } from "./types.js";

export type SettlementRule = {
  sourceId: string;
  metric: string;
  targetValue: number;
  currency: string;
  comparison: "AT_LEAST" | "ABOVE" | "AT_MOST" | "BELOW";
  observationTime: string;
};

export type SettlementEvaluation =
  | { status: "READY"; outcome: "YES" | "NO"; value: number; source: string; observedAt: string; evidenceHash: string }
  | { status: "MANUAL_REVIEW"; reason: string; evidenceHash?: string };

/**
 * Pure, fail-closed evaluator. It never signs, votes, submits, or settles on-chain.
 * The caller must supply the approved observation tolerance and the evidence
 * captured independently near the market's published observation time.
 */
export function evaluateSettlementEvidence(input: {
  rule: SettlementRule;
  assetId: string;
  evidence: ProviderEvidence[];
  toleranceSeconds: number;
  now?: Date;
}): SettlementEvaluation {
  const { rule } = input;
  const targetMs = Date.parse(rule.observationTime);
  if (!Number.isFinite(targetMs) || !Number.isFinite(rule.targetValue) || rule.targetValue <= 0
    || !Number.isInteger(input.toleranceSeconds) || input.toleranceSeconds < 0 || input.toleranceSeconds > 3600) {
    return { status: "MANUAL_REVIEW", reason: "Invalid published rule or observation tolerance." };
  }
  if ((input.now ?? new Date()).getTime() < targetMs) {
    return { status: "MANUAL_REVIEW", reason: "The published observation time has not arrived." };
  }
  const eligible = input.evidence.filter((item) => {
    const observedMs = Date.parse(item.observedAt);
    const retrievedMs = Date.parse(item.retrievedAt);
    return item.provider === rule.sourceId && item.metric === rule.metric && item.assetId === input.assetId
      && item.currency === rule.currency && Number.isFinite(item.value) && item.value > 0
      && Number.isFinite(observedMs) && Number.isFinite(retrievedMs)
      && Math.abs(observedMs - targetMs) <= input.toleranceSeconds * 1000
      && retrievedMs >= observedMs - 60_000 && retrievedMs <= (input.now ?? new Date()).getTime() + 60_000;
  }).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (eligible.length === 0) {
    return { status: "MANUAL_REVIEW", reason: "No fresh, matching observation exists inside the approved time window." };
  }

  const decide = (value: number): "YES" | "NO" => {
    switch (rule.comparison) {
      case "AT_LEAST": return value >= rule.targetValue ? "YES" : "NO";
      case "ABOVE": return value > rule.targetValue ? "YES" : "NO";
      case "AT_MOST": return value <= rule.targetValue ? "YES" : "NO";
      case "BELOW": return value < rule.targetValue ? "YES" : "NO";
    }
  };
  const outcomes = new Set(eligible.map((item) => decide(item.value)));
  const canonicalEvidence = eligible.map((item) => ({
    provider: item.provider, metric: item.metric, assetId: item.assetId,
    observedAt: item.observedAt, retrievedAt: item.retrievedAt, value: item.value,
    currency: item.currency, sourceUrl: item.sourceUrl, rawResponse: item.rawResponse,
  }));
  const evidenceHash = "0x" + createHash("sha256").update(JSON.stringify(canonicalEvidence)).digest("hex");
  if (outcomes.size !== 1) {
    return { status: "MANUAL_REVIEW", reason: "Eligible observations imply conflicting outcomes.", evidenceHash };
  }
  // Use the closest observation; deterministic timestamp ordering breaks ties.
  const selected = [...eligible].sort((a, b) =>
    Math.abs(Date.parse(a.observedAt) - targetMs) - Math.abs(Date.parse(b.observedAt) - targetMs)
    || Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
  return {
    status: "READY", outcome: decide(selected.value), value: selected.value,
    source: selected.provider, observedAt: selected.observedAt, evidenceHash,
  };
}
