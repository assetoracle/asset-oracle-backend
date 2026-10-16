import { createHash } from "node:crypto";
import { marketProposalSchema } from "../services/marketValidation.js";
import type { CandidateGenerationResult, MarketCandidate, ProviderEvidence } from "./types.js";

export type CandidateBuilderOptions = {
  closeAfterMinutes?: number;
  resolveAfterMinutes?: number;
  thresholdPercent?: number;
  maxEvidenceAgeMinutes?: number;
  now?: () => Date;
};

function candidateKey(assetId: string, observationTime: string, thresholdPercent: number): string {
  // One candidate per asset, policy threshold, and UTC observation day prevents
  // a frequent discovery run from creating a new logical market every few minutes.
  const observationDay = new Date(observationTime).toISOString().slice(0, 10);
  return createHash("sha256")
    .update("coingecko:price_usd:" + assetId + ":" + observationDay + ":" + thresholdPercent)
    .digest("hex");
}

/** Proposal-only: never publishes transactions, grants roles, votes, or settles markets. */
export function buildPriceThresholdCandidates(
  evidence: ProviderEvidence[],
  options: CandidateBuilderOptions = {},
): CandidateGenerationResult {
  const now = (options.now ?? (() => new Date()))();
  const closeAfterMinutes = options.closeAfterMinutes ?? 24 * 60;
  const resolveAfterMinutes = options.resolveAfterMinutes ?? 24 * 60 + 5;
  const thresholdPercent = options.thresholdPercent ?? 5;
  const maxEvidenceAgeMinutes = options.maxEvidenceAgeMinutes ?? 15;

  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
    throw new Error("thresholdPercent must be greater than 0 and at most 100.");
  }
  if (closeAfterMinutes < 60 || resolveAfterMinutes <= closeAfterMinutes) {
    throw new Error("Candidate close/resolve times are invalid.");
  }

  const candidates: MarketCandidate[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const item of evidence) {
    const key = candidateKey(item.assetId, item.observedAt, thresholdPercent);
    const observedAt = Date.parse(item.observedAt);
    if (item.provider !== "coingecko" || item.metric !== "price_usd" || item.currency !== "USD") {
      skipped.push({ key, reason: "Unsupported evidence type." });
      continue;
    }
    if (!Number.isFinite(item.value) || item.value <= 0 || !Number.isFinite(observedAt)) {
      skipped.push({ key, reason: "Evidence value or timestamp is invalid." });
      continue;
    }
    const ageMs = now.getTime() - observedAt;
    if (ageMs < -60_000 || ageMs > maxEvidenceAgeMinutes * 60_000) {
      skipped.push({ key, reason: "Evidence is stale or from the future." });
      continue;
    }
    const closesAt = new Date(now.getTime() + closeAfterMinutes * 60_000).toISOString();
    const resolvesAt = new Date(now.getTime() + resolveAfterMinutes * 60_000).toISOString();
    const targetValue = Number((item.value * (1 + thresholdPercent / 100)).toPrecision(12));
    const question = "Will " + item.assetId.toUpperCase() + " be at least " + targetValue + " USD at the stated observation time?";
    const proposal = {
      question,
      description: "Proposed market generated from CoinGecko USD price evidence for " + item.assetId + ". This candidate requires human review before publication.",
      category: "Crypto" as const,
      closesAt,
      resolvesAt,
      resolutionRule: {
        sourceId: "coingecko",
        metric: "price_usd",
        comparison: "AT_LEAST" as const,
        targetValue,
        currency: "USD",
        observationTime: resolvesAt,
        description: "Resolve YES if CoinGecko's " + item.assetId + " USD price is at least " + targetValue + " USD at the stated observation time; otherwise resolve NO. Evidence must be independently reviewed.",
      },
    };
    const parsed = marketProposalSchema.safeParse(proposal);
    if (!parsed.success) {
      skipped.push({ key, reason: "Generated proposal failed market validation." });
      continue;
    }
    candidates.push({
      key,
      proposal: parsed.data,
      evidence: item,
      quality: {
        score: 70,
        reasons: [
          "Fresh CoinGecko observation",
          "Finite positive USD price",
          "Generated market passed existing structural validation",
          "Single-provider evidence requires review before publication",
        ],
      },
    });
  }
  return { candidates, skipped, provider: "coingecko", generatedAt: now.toISOString() };
}
