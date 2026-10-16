import type { MarketProposalInput } from "../services/marketValidation.js";

export type ProviderEvidence = {
  provider: string;
  metric: string;
  assetId: string;
  observedAt: string;
  value: number;
  currency: string;
  sourceUrl: string;
};

export type MarketCandidate = {
  key: string;
  proposal: MarketProposalInput;
  evidence: ProviderEvidence;
  quality: { score: number; reasons: string[] };
};

export type CandidateGenerationResult = {
  candidates: MarketCandidate[];
  skipped: Array<{ key: string; reason: string }>;
  provider: string;
  generatedAt: string;
};
