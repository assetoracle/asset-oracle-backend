import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";

export type MarketEvidenceInput = {
  proposalId: string;
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  contentHash: string;
  rawData: unknown;
  metric: string;
  normalizedValue: unknown | null;
  verificationStatus: "UNREVIEWED";
};

export type StoredMarketEvidence = MarketEvidenceInput & {
  id: string;
  createdAt: string;
};

export async function initializeMarketEvidenceStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_data_evidence (
      id UUID PRIMARY KEY,
      proposal_id UUID NOT NULL REFERENCES market_proposals(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_url TEXT NOT NULL,
      retrieved_at TIMESTAMPTZ NOT NULL,
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
      raw_data JSONB NOT NULL,
      metric TEXT NOT NULL,
      normalized_value JSONB,
      verification_status TEXT NOT NULL DEFAULT 'UNREVIEWED'
        CHECK (verification_status IN ('UNREVIEWED', 'ACCEPTED', 'REJECTED', 'STALE')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (proposal_id, provider, content_hash)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS market_data_evidence_proposal_retrieved_idx
    ON market_data_evidence (proposal_id, retrieved_at DESC)
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_data_collection_state (
      proposal_id UUID NOT NULL REFERENCES market_proposals(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      last_attempted_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (proposal_id, provider)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS market_data_collection_state_attempted_idx
    ON market_data_collection_state (last_attempted_at DESC)
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS market_data_provider_cooldowns (
      provider TEXT PRIMARY KEY,
      cooldown_until TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_data_evidence_reviews (
      id UUID PRIMARY KEY,
      evidence_id UUID NOT NULL REFERENCES market_data_evidence(id) ON DELETE CASCADE,
      validator_address TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('ACCEPTED', 'REJECTED')),
      note TEXT,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (evidence_id, validator_address)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS market_data_evidence_reviews_evidence_idx
    ON market_data_evidence_reviews (evidence_id, reviewed_at ASC)
  `);
}

export async function saveMarketEvidence(input: MarketEvidenceInput): Promise<{ evidence: StoredMarketEvidence; inserted: boolean }> {
  const uuid = randomUUID();
  const result = await database.query(`
    INSERT INTO market_data_evidence
      (id, proposal_id, provider, source_url, retrieved_at, content_hash, raw_data, metric, normalized_value, verification_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'UNREVIEWED')
    ON CONFLICT (proposal_id, provider, content_hash) DO NOTHING
    RETURNING id, proposal_id, provider, source_url, retrieved_at, content_hash, raw_data,
      metric, normalized_value, verification_status, created_at
  `, [uuid, input.proposalId, input.provider, input.sourceUrl, input.retrievedAt, input.contentHash,
    JSON.stringify(input.rawData), input.metric, input.normalizedValue === null ? null : JSON.stringify(input.normalizedValue)]);
  if (result.rows[0]) return { evidence: mapRow(result.rows[0]), inserted: true };

  // The provider was queried again and returned identical content. Refresh the
  // observation timestamp without changing the original payload hash or review.
  const existing = await database.query(`
    UPDATE market_data_evidence
    SET retrieved_at=$4, source_url=$5
    WHERE proposal_id=$1 AND provider=$2 AND content_hash=$3
    RETURNING id, proposal_id, provider, source_url, retrieved_at, content_hash, raw_data,
      metric, normalized_value, verification_status, created_at
  `, [input.proposalId, input.provider, input.contentHash, input.retrievedAt, input.sourceUrl]);
  if (!existing.rows[0]) throw new Error("Evidence insert conflict could not be reconciled.");
  return { evidence: mapRow(existing.rows[0]), inserted: false };
}

function mapRow(row: any): StoredMarketEvidence {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    provider: row.provider,
    sourceUrl: row.source_url,
    retrievedAt: new Date(row.retrieved_at).toISOString(),
    contentHash: row.content_hash,
    rawData: row.raw_data,
    metric: row.metric,
    normalizedValue: row.normalized_value,
    verificationStatus: row.verification_status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listMarketEvidence(proposalId: string): Promise<StoredMarketEvidence[]> {
  const result = await database.query(`
    SELECT id, proposal_id, provider, source_url, retrieved_at, content_hash, raw_data,
      metric, normalized_value, verification_status, created_at
    FROM market_data_evidence WHERE proposal_id=$1 ORDER BY retrieved_at DESC LIMIT 100
  `, [proposalId]);
  return result.rows.map(mapRow);
}

export async function getLatestMarketEvidenceAt(proposalId: string, provider: string): Promise<string | null> {
  const result = await database.query<{ retrieved_at: string | Date }>(
    `SELECT MAX(retrieved_at) AS retrieved_at
     FROM market_data_evidence WHERE proposal_id=$1 AND provider=$2`,
    [proposalId, provider],
  );
  const value = result.rows[0]?.retrieved_at;
  return value ? new Date(value).toISOString() : null;
}


/** Timestamp of the most recent collection attempt, including unchanged or failed responses. */
export async function getLatestMarketEvidenceAttemptAt(proposalId: string, provider: string): Promise<string | null> {
  const result = await database.query<{ last_attempted_at: string | Date }>(
    `SELECT last_attempted_at
     FROM market_data_collection_state WHERE proposal_id=$1 AND provider=$2`,
    [proposalId, provider],
  );
  const value = result.rows[0]?.last_attempted_at;
  return value ? new Date(value).toISOString() : null;
}

/** Record before the provider call so unchanged responses and failures are rate-spaced too. */
export async function recordMarketEvidenceAttempt(proposalId: string, provider: string): Promise<void> {
  await database.query(
    `INSERT INTO market_data_collection_state (proposal_id, provider, last_attempted_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (proposal_id, provider)
     DO UPDATE SET last_attempted_at = EXCLUDED.last_attempted_at`,
    [proposalId, provider],
  );
}


/** Read a provider-wide cooldown shared by all scheduled worker executions. */
export async function getMarketDataProviderCooldown(provider: string): Promise<string | null> {
  const result = await database.query<{ cooldown_until: string | Date }>(
    `SELECT cooldown_until FROM market_data_provider_cooldowns
     WHERE provider=$1 AND cooldown_until > NOW()`, [provider],
  );
  const value = result.rows[0]?.cooldown_until;
  return value ? new Date(value).toISOString() : null;
}

/** Persist rate-limit cooldown so separate scheduled runs do not immediately retry a throttled provider. */
export async function setMarketDataProviderCooldown(provider: string, minutes: number, reason: string): Promise<void> {
  const boundedMinutes = Math.max(1, Math.min(120, Math.floor(minutes)));
  await database.query(
    `INSERT INTO market_data_provider_cooldowns (provider, cooldown_until, reason, updated_at)
     VALUES ($1, NOW() + ($2 * INTERVAL '1 minute'), $3, NOW())
     ON CONFLICT (provider) DO UPDATE SET
       cooldown_until = GREATEST(market_data_provider_cooldowns.cooldown_until, EXCLUDED.cooldown_until),
       reason = EXCLUDED.reason,
       updated_at = NOW()`,
    [provider, boundedMinutes, reason.slice(0, 240)],
  );
}

export type PublicMarketTeamIdentity = {
  home: { name: string; logoUrl: string | null };
  away: { name: string; logoUrl: string | null };
};

/** Return team identity only from validator-accepted football evidence. */
export async function listAcceptedFootballTeamIdentity(proposalIds: string[]): Promise<Map<string, PublicMarketTeamIdentity>> {
  if (proposalIds.length === 0) return new Map();
  const result = await database.query(
    `SELECT DISTINCT ON (proposal_id) proposal_id, raw_data
       FROM market_data_evidence
      WHERE proposal_id = ANY($1::uuid[])
        AND provider IN ('sportmonks', 'api-football')
        AND verification_status = 'ACCEPTED'
      ORDER BY proposal_id, retrieved_at DESC`,
    [proposalIds],
  );
  const identities = new Map<string, PublicMarketTeamIdentity>();
  for (const row of result.rows) {
    const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data as Record<string, unknown> : {};
    const fixtures = Array.isArray(raw.data) ? raw.data as Record<string, unknown>[] : Array.isArray(raw.response) ? raw.response as Record<string, unknown>[] : [];
    const proposal = await database.query<{ question: string; description: string }>(
      `SELECT question, description FROM market_proposals WHERE id=$1 AND status='APPROVED'`,
      [row.proposal_id],
    );
    const context = `${proposal.rows[0]?.question ?? ""} ${proposal.rows[0]?.description ?? ""}`.toLowerCase();
    for (const fixture of fixtures) {
      let home: Record<string, unknown> | undefined;
      let away: Record<string, unknown> | undefined;
      if (Array.isArray(fixture.participants)) {
        const participants = fixture.participants as Record<string, unknown>[];
        home = participants.find((team) => (team.meta as Record<string, unknown> | undefined)?.location === "home");
        away = participants.find((team) => (team.meta as Record<string, unknown> | undefined)?.location === "away");
        if (!home || !away) continue;
        const homeName = typeof home.name === "string" ? home.name : "";
        const awayName = typeof away.name === "string" ? away.name : "";
        if (!homeName || !awayName || !context.includes(homeName.toLowerCase()) || !context.includes(awayName.toLowerCase())) continue;
        const safeUrl = (value: unknown) => {
          if (typeof value !== "string") return null;
          try { const url = new URL(value); return url.protocol === "https:" && ["cdn.sportmonks.com", "media.api-sports.io"].includes(url.hostname) ? url.toString() : null; } catch { return null; }
        };
        identities.set(String(row.proposal_id), {
          home: { name: homeName, logoUrl: safeUrl(home.image_path) },
          away: { name: awayName, logoUrl: safeUrl(away.image_path) },
        });
        break;
      } else {
        const teams = fixture.teams as Record<string, unknown> | undefined;
        home = teams?.home as Record<string, unknown> | undefined;
        away = teams?.away as Record<string, unknown> | undefined;
        if (!home || !away) continue;
        const homeName = typeof home.name === "string" ? home.name : "";
        const awayName = typeof away.name === "string" ? away.name : "";
        if (!homeName || !awayName || !context.includes(homeName.toLowerCase()) || !context.includes(awayName.toLowerCase())) continue;
        const safeUrl = (value: unknown) => {
          if (typeof value !== "string") return null;
          try { const url = new URL(value); return url.protocol === "https:" && ["cdn.sportmonks.com", "media.api-sports.io"].includes(url.hostname) ? url.toString() : null; } catch { return null; }
        };
        identities.set(String(row.proposal_id), {
          home: { name: homeName, logoUrl: safeUrl(home.logo) },
          away: { name: awayName, logoUrl: safeUrl(away.logo) },
        });
        break;
      }
    }
  }
  return identities;
}
