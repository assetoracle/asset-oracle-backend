import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import { keccak256, toBytes } from "viem";
import type { StoredMarketEvidence } from "./marketEvidenceStore.js";
import { evaluateResolutionRule, isHistoricalObservationAligned, type ResolutionComparison } from "./marketResolutionValidation.js";
export { evaluateResolutionRule, isHistoricalObservationAligned } from "./marketResolutionValidation.js";

export type ResolutionRecommendation = {
  proposalId: string;
  evidenceId: string;
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  metric: string;
  observedValue: number;
  comparison: ResolutionComparison;
  targetValue: number;
  proposedOutcome: "YES" | "NO";
  evidenceHash: string;
  contentHash: string;
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
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL DEFAULT 'PENDING_VALIDATORS'
        CHECK (status IN ('PENDING_VALIDATORS', 'CONFIRMED', 'REJECTED', 'SUPERSEDED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("ALTER TABLE market_resolution_recommendations ADD COLUMN IF NOT EXISTS content_hash TEXT");
  // Keep prior recommendation versions immutable when a demonstrably misaligned,
  // still-unreviewed recommendation is safely revalidated.
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_resolution_recommendation_history (
      id UUID PRIMARY KEY,
      proposal_id UUID NOT NULL REFERENCES market_proposals(id) ON DELETE CASCADE,
      evidence_id UUID NOT NULL REFERENCES market_data_evidence(id) ON DELETE RESTRICT,
      provider TEXT NOT NULL, source_url TEXT NOT NULL, retrieved_at TIMESTAMPTZ NOT NULL,
      metric TEXT NOT NULL, observed_value DOUBLE PRECISION NOT NULL,
      comparison TEXT NOT NULL, target_value DOUBLE PRECISION NOT NULL,
      proposed_outcome TEXT NOT NULL, evidence_hash TEXT NOT NULL, content_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

/** True only when stored CoinGecko/GDELT evidence proves it used the configured observation time. */
export async function isRecommendationAlignedWithObservationTime(
  proposalId: string,
  provider: string,
  observationTime: string,
): Promise<boolean> {
  const result = await database.query(`
    SELECT e.raw_data FROM market_resolution_recommendations r
    INNER JOIN market_data_evidence e ON e.id = r.evidence_id
    WHERE r.proposal_id = $1 AND lower(r.provider) = $2
  `, [proposalId, provider.trim().toLowerCase()]);
  return isHistoricalObservationAligned(provider, observationTime, result.rows[0]?.raw_data);
}

export async function saveResolutionRecommendation(input: {
  proposalId: string;
  evidence: StoredMarketEvidence;
  comparison: ResolutionRecommendation["comparison"];
  targetValue: number;
}): Promise<ResolutionRecommendation> {
  const observedValue = numericValue(input.evidence.normalizedValue);
  const proposedOutcome = evaluateResolutionRule(observedValue, input.comparison, input.targetValue);
  const evidenceHash = keccak256(toBytes(input.evidence.sourceUrl.trim()));
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`
      SELECT r.*, e.verification_status
      FROM market_resolution_recommendations r
      INNER JOIN market_data_evidence e ON e.id = r.evidence_id
      WHERE r.proposal_id = $1
      FOR UPDATE OF r, e
    `, [input.proposalId]);

    if (existing.rows[0]) {
      const previous = existing.rows[0];
      if (previous.evidence_id === input.evidence.id) {
        await client.query("COMMIT");
        return mapRecommendation(previous);
      }
      if (previous.status !== "PENDING_VALIDATORS" || previous.verification_status !== "UNREVIEWED") {
        throw new Error("Existing recommendation is not eligible for automatic revalidation because it is no longer pending or its evidence has a final review.");
      }
      const reviews = await client.query(
        "SELECT 1 FROM market_data_evidence_reviews WHERE evidence_id = $1 LIMIT 1",
        [previous.evidence_id],
      );
      if (reviews.rows.length) {
        throw new Error("Existing recommendation cannot be revalidated after validator review has begun.");
      }
      const onchainVotes = await client.query(`
        SELECT 1
        FROM validator_source_links v
        INNER JOIN market_proposals p ON p.id = $1
        WHERE v.chain_id = 42421
          AND lower(v.manager_address) = lower(p.onchain_manager_address)
          AND v.market_id = p.onchain_market_id
        LIMIT 1
      `, [input.proposalId]);
      if (onchainVotes.rows.length) {
        throw new Error("Existing recommendation cannot be revalidated after on-chain validator voting has begun.");
      }

      await client.query(`
        INSERT INTO market_resolution_recommendation_history
          (id, proposal_id, evidence_id, provider, source_url, retrieved_at, metric,
           observed_value, comparison, target_value, proposed_outcome, evidence_hash,
           content_hash, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [randomUUID(), previous.proposal_id, previous.evidence_id, previous.provider,
        previous.source_url, previous.retrieved_at, previous.metric, previous.observed_value,
        previous.comparison, previous.target_value, previous.proposed_outcome, previous.evidence_hash,
        previous.content_hash ?? "", "SUPERSEDED", previous.created_at]);

      await client.query(
        "UPDATE market_data_evidence SET verification_status = 'STALE' WHERE id = $1 AND verification_status = 'UNREVIEWED'",
        [previous.evidence_id],
      );
      const updated = await client.query(`
        UPDATE market_resolution_recommendations SET
          evidence_id=$2, provider=$3, source_url=$4, retrieved_at=$5, metric=$6,
          observed_value=$7, comparison=$8, target_value=$9, proposed_outcome=$10,
          evidence_hash=$11, content_hash=$12, status='PENDING_VALIDATORS', created_at=NOW()
        WHERE proposal_id=$1 RETURNING *
      `, [input.proposalId, input.evidence.id, input.evidence.provider, input.evidence.sourceUrl,
        input.evidence.retrievedAt, input.evidence.metric, observedValue, input.comparison,
        input.targetValue, proposedOutcome, evidenceHash, input.evidence.contentHash]);
      await client.query("COMMIT");
      return mapRecommendation(updated.rows[0]);
    }

    const inserted = await client.query(`
      INSERT INTO market_resolution_recommendations
        (proposal_id, evidence_id, provider, source_url, retrieved_at, metric, observed_value,
         comparison, target_value, proposed_outcome, evidence_hash, content_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [input.proposalId, input.evidence.id, input.evidence.provider, input.evidence.sourceUrl,
      input.evidence.retrievedAt, input.evidence.metric, observedValue, input.comparison,
      input.targetValue, proposedOutcome, evidenceHash, input.evidence.contentHash]);
    await client.query("COMMIT");
    return mapRecommendation(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
    contentHash: row.content_hash ?? "",
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
