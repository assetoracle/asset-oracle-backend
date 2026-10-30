import { database } from "../config/database.js";
import type { MarketCandidate } from "./types.js";

export type StoredAutomationCandidate = MarketCandidate & {
  id: string;
  status: "PENDING_REVIEW" | "DISMISSED" | "APPROVED_FOR_PUBLICATION" | "PUBLISHED";
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
        CHECK (status IN ('PENDING_REVIEW', 'DISMISSED', 'APPROVED_FOR_PUBLICATION', 'PUBLISHED')),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Upgrade databases created by earlier proposal-only versions. CREATE TABLE IF NOT EXISTS
  // does not update an existing CHECK constraint when a new status is introduced.
  await database.query(`
    ALTER TABLE automation_market_candidates
      DROP CONSTRAINT IF EXISTS automation_market_candidates_status_check
  `);
  await database.query(`
    ALTER TABLE automation_market_candidates
      ADD CONSTRAINT automation_market_candidates_status_check
      CHECK (status IN ('PENDING_REVIEW', 'DISMISSED', 'APPROVED_FOR_PUBLICATION', 'PUBLISHED'))
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
    CREATE TABLE IF NOT EXISTS automation_candidate_approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_id UUID NOT NULL REFERENCES automation_market_candidates(id),
      approver_wallet TEXT NOT NULL,
      approver_role TEXT NOT NULL CHECK (approver_role IN ('ADMIN', 'MARKET_MAKER')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (candidate_id, approver_wallet)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS automation_candidate_approvals_candidate_idx
    ON automation_candidate_approvals (candidate_id, created_at ASC)
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
      retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (candidate_id, observed_at, value)
    )
  `);
  await database.query(`
    ALTER TABLE automation_candidate_observations
      ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
  await database.query(`
    ALTER TABLE automation_candidate_observations
      ADD COLUMN IF NOT EXISTS raw_response JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS automation_price_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      metric TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      retrieved_at TIMESTAMPTZ NOT NULL,
      value DOUBLE PRECISION NOT NULL CHECK (value > 0),
      currency TEXT NOT NULL,
      source_url TEXT NOT NULL,
      raw_response JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, metric, asset_id, observed_at, value)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS automation_price_observations_lookup_idx
    ON automation_price_observations (provider, metric, asset_id, observed_at DESC)
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
          (candidate_id, provider, metric, asset_id, observed_at, value, currency, source_url, retrieved_at, raw_response)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
          candidate.evidence.retrievedAt,
          JSON.stringify(candidate.evidence.rawResponse),
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

/** Records one of the three eligible approvals. The first approval reaches the threshold. */
export async function approveAutomationCandidate(input: {
  id: string;
  approverWallet: string;
  approverRole: "ADMIN" | "MARKET_MAKER";
}): Promise<{ candidate: StoredAutomationCandidate; approvalCount: number; newlyApproved: boolean } | null> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const candidateResult = await client.query<CandidateRow>(
      "SELECT * FROM automation_market_candidates WHERE id = $1 FOR UPDATE",
      [input.id],
    );
    if (!candidateResult.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const candidate = candidateResult.rows[0];
    if (candidate.status === "DISMISSED" || candidate.status === "PUBLISHED") {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO automation_candidate_approvals (candidate_id, approver_wallet, approver_role)
       VALUES ($1, $2, $3)
       ON CONFLICT (candidate_id, approver_wallet) DO NOTHING
       RETURNING id`,
      [input.id, input.approverWallet.toLowerCase(), input.approverRole],
    );
    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM automation_candidate_approvals WHERE candidate_id = $1",
      [input.id],
    );
    const approvalCount = Number(countResult.rows[0]?.count ?? 0);
    const newlyApproved = candidate.status !== "APPROVED_FOR_PUBLICATION" && approvalCount >= 1;
    if (newlyApproved) {
      await client.query(
        "UPDATE automation_market_candidates SET status = 'APPROVED_FOR_PUBLICATION' WHERE id = $1 AND status = 'PENDING_REVIEW'",
        [input.id],
      );
    }
    const refreshed = await client.query<CandidateRow>(
      "SELECT * FROM automation_market_candidates WHERE id = $1",
      [input.id],
    );
    await client.query("COMMIT");
    return { candidate: mapRow(refreshed.rows[0]), approvalCount, newlyApproved };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


/** Persists provider observations independently of candidate generation for future resolution. */
export async function recordProviderObservations(evidence: MarketCandidate["evidence"][]): Promise<{ inserted: number; existing: number }> {
  if (evidence.length === 0) return { inserted: 0, existing: 0 };
  const client = await database.connect();
  let inserted = 0;
  let existing = 0;
  try {
    await client.query("BEGIN");
    for (const item of evidence) {
      const result = await client.query(
        `INSERT INTO automation_price_observations
          (provider, metric, asset_id, observed_at, retrieved_at, value, currency, source_url, raw_response)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (provider, metric, asset_id, observed_at, value) DO NOTHING
         RETURNING id`,
        [item.provider,item.metric,item.assetId,item.observedAt,item.retrievedAt,item.value,item.currency,item.sourceUrl,JSON.stringify(item.rawResponse)],
      );
      if (result.rowCount) inserted++;
      else existing++;
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

/** Returns only observations within the caller-specified tolerance; no nearest-value guessing. */
export async function findPriceObservations(input: {
  provider: string; metric: string; assetId: string; targetAt: string; toleranceSeconds: number;
}): Promise<Array<{ observedAt: string; retrievedAt: string; value: number; currency: string; rawResponse: unknown }>> {
  if (!Number.isFinite(Date.parse(input.targetAt)) || !Number.isInteger(input.toleranceSeconds)
    || input.toleranceSeconds < 0 || input.toleranceSeconds > 3600) {
    throw new Error("Invalid observation target or tolerance.");
  }
  const result = await database.query<{
    observed_at: string | Date; retrieved_at: string | Date; value: number; currency: string; raw_response: unknown;
  }>(
    `SELECT observed_at, retrieved_at, value, currency, raw_response
     FROM automation_price_observations
     WHERE provider = $1 AND metric = $2 AND asset_id = $3
       AND observed_at BETWEEN $4::timestamptz - ($5 * INTERVAL '1 second')
                           AND $4::timestamptz + ($5 * INTERVAL '1 second')
     ORDER BY ABS(EXTRACT(EPOCH FROM (observed_at - $4::timestamptz))) ASC, observed_at ASC`,
    [input.provider,input.metric,input.assetId,input.targetAt,input.toleranceSeconds],
  );
  return result.rows.map(row => ({
    observedAt: new Date(row.observed_at).toISOString(),
    retrievedAt: new Date(row.retrieved_at).toISOString(),
    value: Number(row.value), currency: row.currency, rawResponse: row.raw_response,
  }));
}
