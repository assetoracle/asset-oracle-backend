import { database } from "../config/database.js";
import type { StoredMarketEvidence } from "./marketEvidenceStore.js";

export type ResolutionRecommendation = {
  proposalId: string;
  evidenceId: string;
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  metric: string;
  observedValue: number;
  comparison: "ABOVE" | "AT_LEAST" | "BELOW" | "EQUALS";
  targetValue: number;
  proposedOutcome: "YES" | "NO";
  evidenceHash: string;
  status: "PENDING_VALIDATORS" | "CONFIRMED" | "REJECTED" | "SUPERSEDED";
  createdAt: string;
};

export async function initializeMarketResolutionVerificationStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_resolution_recommendations (
      proposal_id UUID PRIMARY KEY REFERENCES market_proposals(id) ON DELETE CASCADE,
      evidence_id UUID NOT NULL REFERENCES market_data_evidence(id) ON DELETE RESTRICT,
      provider TEXT NOT NULL,
      source_url TEXT NOT NULL,
      retrieved_at TIMESTAMPTZ NOT NULL,
      metric TEXT NOT NULL,
      observed_value DOUBLE PRECISION NOT NULL,
      comparison TEXT NOT NULL CHECK (comparison IN ('ABOVE', 'AT_LEAST', 'BELOW', 'EQUALS')),
      target_value DOUBLE PRECISION NOT NULL,
      proposed_outcome TEXT NOT NULL CHECK (proposed_outcome IN ('YES', 'NO')),
      evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^0x[a-f0-9]{64}$'),
      status TEXT NOT NULL DEFAULT 'PENDING_VALIDATORS'
        CHECK (status IN ('PENDING_VALIDATORS', 'CONFIRMED', 'REJECTED', 'SUPERSEDED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function numericValue(value: unknown): number {
  const candidate = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value)
    : typeof value === "object" && value !== null && "value" in value
      ? Number((value as { value: unknown }).value) : NaN;
  if (!Number.isFinite(candidate)) {
    throw new Error("Provider response did not contain a finite numeric value for the configured resolution metric.");
  }
  return candidate;
}

export function evaluateResolutionRule(
  value: number,
  comparison: ResolutionRecommendation["comparison"],
  target: number,
): "YES" | "NO" {
  const matches = comparison === "ABOVE" ? value > target
    : comparison === "AT_LEAST" ? value >= target
    : comparison === "BELOW" ? value < target
    : value === target;
  return matches ? "YES" : "NO";
}

export async function saveResolutionRecommendation(input: {
  proposalId: string;
  evidence: StoredMarketEvidence;
  comparison: ResolutionRecommendation["comparison"];
  targetValue: number;
}): Promise<ResolutionRecommendation> {
  const observedValue = numericValue(input.evidence.normalizedValue);
  const proposedOutcome = evaluateResolutionRule(observedValue, input.comparison, input.targetValue);
  const fetchedAt = new Date().toISOString();
  const result = await database.query(`
    INSERT INTO market_resolution_recommendations
      (proposal_id, evidence_id, provider, source_url, retrieved_at, metric, observed_value,
       comparison, target_value, proposed_outcome, evidence_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (proposal_id) DO NOTHING
    RETURNING *
  `, [input.proposalId, input.evidence.id, input.evidence.provider, input.evidence.sourceUrl,
    fetchedAt, input.evidence.metric, observedValue, input.comparison, input.targetValue,
    proposedOutcome, `0x${input.evidence.contentHash}`]);
  if (!result.rows[0]) {
    const existing = await database.query(
      "SELECT * FROM market_resolution_recommendations WHERE proposal_id=$1",
      [input.proposalId],
    );
    if (!existing.rows[0]) throw new Error("Resolution recommendation insert could not be reconciled.");
    return mapRecommendation(existing.rows[0]);
  }
  return mapRecommendation(result.rows[0]);
}

function mapRecommendation(row: any): ResolutionRecommendation {
  return {
    proposalId: row.proposal_id,
    evidenceId: row.evidence_id,
    provider: row.provider,
    sourceUrl: row.source_url,
    retrievedAt: new Date(row.retrieved_at).toISOString(),
    metric: row.metric,
    observedValue: Number(row.observed_value),
    comparison: row.comparison,
    targetValue: Number(row.target_value),
    proposedOutcome: row.proposed_outcome,
    evidenceHash: row.evidence_hash,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function getResolutionRecommendation(proposalId: string): Promise<ResolutionRecommendation | null> {
  const result = await database.query(
    "SELECT * FROM market_resolution_recommendations WHERE proposal_id=$1",
    [proposalId],
  );
  return result.rows[0] ? mapRecommendation(result.rows[0]) : null;
}
