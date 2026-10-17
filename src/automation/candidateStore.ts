import { database } from "../config/database.js";
import type { MarketCandidate } from "./types.js";

export type StoredAutomationCandidate = MarketCandidate & {
  id: string;
  status: "PENDING_REVIEW" | "DISMISSED" | "PUBLISHED";
  firstSeenAt: string;
  lastSeenAt: string;
};

type CandidateRow = {
  id: string;
  candidate_key: string;
  proposal: MarketCandidate["proposal"] | string;
  evidence: MarketCandidate["evidence"] | string;
  quality: MarketCandidate["quality"] | string;
  status: StoredAutomationCandidate["status"];
  first_seen_at: string | Date;
  last_seen_at: string | Date;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function mapRow(row: CandidateRow): StoredAutomationCandidate {
  return {
    id: row.id,
    key: row.candidate_key,
    proposal: parseJson(row.proposal),
    evidence: parseJson(row.evidence),
    quality: parseJson(row.quality),
    status: row.status,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}

export async function initializeAutomationCandidateStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS automation_market_candidates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_key TEXT NOT NULL UNIQUE,
      proposal JSONB NOT NULL,
      evidence JSONB NOT NULL,
      quality JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
        CHECK (status IN ('PENDING_REVIEW', 'DISMISSED', 'PUBLISHED')),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS automation_market_candidates_status_last_seen_idx
    ON automation_market_candidates (status, last_seen_at DESC)
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS automation_candidate_review_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_id UUID NOT NULL REFERENCES automation_market_candidates(id),
      admin_wallet TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('DISMISS', 'RESTORE')),
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS automation_candidate_review_events_candidate_idx
    ON automation_candidate_review_events (candidate_id, created_at DESC)
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS automation_candidate_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_id UUID NOT NULL REFERENCES automation_market_candidates(id),
      provider TEXT NOT NULL,
      metric TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL,
      source_url TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (candidate_id, observed_at, value)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS automation_candidate_observations_candidate_idx
    ON automation_candidate_observations (candidate_id, observed_at DESC)
  `);
}

export async function upsertAutomationCandidates(
  candidates: MarketCandidate[],
): Promise<{ inserted: number; existing: number }> {
  if (candidates.length === 0) return { inserted: 0, existing: 0 };

  const client = await database.connect();
  let inserted = 0;
  let existing = 0;
  try {
    await client.query("BEGIN");
    for (const candidate of candidates) {
      const result = await client.query<{ id: string; candidate_key: string; inserted: boolean }>(
        `INSERT INTO automation_market_candidates
          (candidate_key, proposal, evidence, quality)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
         ON CONFLICT (candidate_key) DO UPDATE
           SET last_seen_at = NOW()
         RETURNING id, candidate_key, (xmax = 0) AS inserted`,
        [
          candidate.key,
          JSON.stringify(candidate.proposal),
          JSON.stringify(candidate.evidence),
          JSON.stringify(candidate.quality),
        ],
      );
      const stored = result.rows[0];
      if (!stored) throw new Error("Candidate upsert returned no row.");
      if (stored.inserted) inserted++;
      else existing++;

      // Preserve the first candidate basis; append later observations atomically.
      await client.query(
        `INSERT INTO automation_candidate_observations
          (candidate_id, provider, metric, asset_id, observed_at, value, currency, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (candidate_id, observed_at, value) DO NOTHING`,
        [
          stored.id,
          candidate.evidence.provider,
          candidate.evidence.metric,
          candidate.evidence.assetId,
          candidate.evidence.observedAt,
          candidate.evidence.value,
          candidate.evidence.currency,
          candidate.evidence.sourceUrl,
        ],
      );
    }
    await client.query("COMMIT");
    return { inserted, existing };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAutomationCandidates(options: {
  status?: StoredAutomationCandidate["status"];
  limit?: number;
} = {}): Promise<StoredAutomationCandidate[]> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  const result = await database.query<CandidateRow>(
    options.status
      ? `SELECT * FROM automation_market_candidates
         WHERE status = $1 ORDER BY last_seen_at DESC LIMIT $2`
      : `SELECT * FROM automation_market_candidates
         ORDER BY last_seen_at DESC LIMIT $1`,
    options.status ? [options.status, limit] : [limit],
  );
  return result.rows.map(mapRow);
}

export async function reviewAutomationCandidate(input: {
  id: string;
  adminWallet: string;
  action: "DISMISS" | "RESTORE";
  reason: string;
}): Promise<StoredAutomationCandidate | null> {
  const targetStatus = input.action === "DISMISS" ? "DISMISSED" : "PENDING_REVIEW";
  const expectedStatus = input.action === "DISMISS" ? "PENDING_REVIEW" : "DISMISSED";
  const result = await database.query<CandidateRow>(
    `WITH changed AS (
       UPDATE automation_market_candidates
       SET status = $2
       WHERE id = $1 AND status = $3
       RETURNING *
     ), audited AS (
       INSERT INTO automation_candidate_review_events
         (candidate_id, admin_wallet, action, reason)
       SELECT id, $4, $5, $6 FROM changed
       RETURNING candidate_id
     )
     SELECT changed.*
     FROM changed
     JOIN audited ON audited.candidate_id = changed.id`,
    [input.id, targetStatus, expectedStatus, input.adminWallet, input.action, input.reason],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
