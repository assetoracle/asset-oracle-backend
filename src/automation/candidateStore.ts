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
}

export async function upsertAutomationCandidates(
  candidates: MarketCandidate[],
): Promise<{ inserted: number; existing: number }> {
  let inserted = 0;
  let existing = 0;
  for (const candidate of candidates) {
    const result = await database.query<{ candidate_key: string; inserted: boolean }>(
      `INSERT INTO automation_market_candidates
        (candidate_key, proposal, evidence, quality)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
       ON CONFLICT (candidate_key) DO UPDATE
         SET last_seen_at = NOW()
       RETURNING candidate_key, (xmax = 0) AS inserted`,
      [
        candidate.key,
        JSON.stringify(candidate.proposal),
        JSON.stringify(candidate.evidence),
        JSON.stringify(candidate.quality),
      ],
    );
    if (result.rows[0]?.inserted) inserted++;
    else existing++;
  }
  return { inserted, existing };
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
