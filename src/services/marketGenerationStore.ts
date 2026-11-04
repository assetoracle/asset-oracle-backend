import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import type { MarketProposalInput } from "./marketValidation.js";
import { createMarketProposal, type StoredMarketProposal } from "./marketStore.js";

export type MarketCandidate = {
  id: string;
  templateId: string;
  category: MarketProposalInput["category"];
  proposal: MarketProposalInput;
  status: "PENDING_REVIEW" | "DISMISSED" | "PROMOTED";
  createdAt: string;
};

export async function initializeMarketGenerationStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_generation_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      next_category_index INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    INSERT INTO market_generation_state (id, next_category_index)
    VALUES (1, 0) ON CONFLICT (id) DO NOTHING
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_generation_candidates (
      id UUID PRIMARY KEY,
      template_id TEXT NOT NULL,
      category TEXT NOT NULL,
      proposal JSONB NOT NULL,
      proposal_hash TEXT NOT NULL UNIQUE CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
        CHECK (status IN ('PENDING_REVIEW', 'DISMISSED', 'PROMOTED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS market_generation_candidates_status_created_idx
    ON market_generation_candidates (status, created_at DESC)
  `);
}

const CATEGORIES = ["Crypto", "Economics", "Regional", "RWA", "Sports"] as const;

export async function claimNextGenerationCategory(): Promise<MarketProposalInput["category"]> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ next_category_index: number }>(
      "SELECT next_category_index FROM market_generation_state WHERE id=1 FOR UPDATE",
    );
    const index = Number(result.rows[0]?.next_category_index ?? 0) % CATEGORIES.length;
    await client.query(
      "UPDATE market_generation_state SET next_category_index=$1, updated_at=NOW() WHERE id=1",
      [(index + 1) % CATEGORIES.length],
    );
    await client.query("COMMIT");
    return CATEGORIES[index];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function saveMarketCandidate(input: {
  templateId: string;
  proposal: MarketProposalInput;
}): Promise<{ candidate: MarketCandidate | null; inserted: boolean }> {
  const hash = createProposalHash(input.proposal);
  const id = randomUUID();
  const result = await database.query(
    `INSERT INTO market_generation_candidates
      (id, template_id, category, proposal, proposal_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (proposal_hash) DO NOTHING
     RETURNING id, template_id, category, proposal, status, created_at`,
    [id, input.templateId, input.proposal.category, JSON.stringify(input.proposal), hash],
  );
  if (!result.rows[0]) return { candidate: null, inserted: false };
  return { candidate: mapCandidate(result.rows[0]), inserted: true };
}

function createProposalHash(proposal: MarketProposalInput): string {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

import { createHash } from "node:crypto";

function mapCandidate(row: any): MarketCandidate {
  return {
    id: row.id,
    templateId: row.template_id,
    category: row.category,
    proposal: typeof row.proposal === "string" ? JSON.parse(row.proposal) : row.proposal,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listPendingMarketCandidates(limit = 100): Promise<MarketCandidate[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await database.query(
    `SELECT id, template_id, category, proposal, status, created_at
     FROM market_generation_candidates
     WHERE status='PENDING_REVIEW'
     ORDER BY created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map(mapCandidate);
}


export async function reviewMarketCandidate(input: {
  candidateId: string;
  decision: "DISMISSED" | "PROMOTED";
  reviewerAddress: string;
}): Promise<{ result: "UPDATED" | "NOT_FOUND" | "CONFLICT"; proposal?: StoredMarketProposal }> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const candidateResult = await client.query<{
      id: string;
      template_id: string;
      category: string;
      proposal: MarketProposalInput | string;
      status: MarketCandidate["status"];
    }>(
      `SELECT id, template_id, category, proposal, status
       FROM market_generation_candidates WHERE id=$1 FOR UPDATE`,
      [input.candidateId],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) {
      await client.query("ROLLBACK");
      return { result: "NOT_FOUND" };
    }
    if (candidate.status !== "PENDING_REVIEW") {
      await client.query("ROLLBACK");
      return { result: "CONFLICT" };
    }

    let proposal: StoredMarketProposal | undefined;
    if (input.decision === "PROMOTED") {
      const proposalInput = typeof candidate.proposal === "string"
        ? JSON.parse(candidate.proposal) as MarketProposalInput
        : candidate.proposal;
      proposal = await createMarketProposal(proposalInput, input.reviewerAddress, client);
    }

    const updated = await client.query(
      `UPDATE market_generation_candidates
       SET status=$2 WHERE id=$1 AND status='PENDING_REVIEW' RETURNING id`,
      [input.candidateId, input.decision],
    );
    if ((updated.rowCount ?? updated.rows.length) !== 1) {
      throw new Error("Candidate review state changed concurrently.");
    }
    await client.query("COMMIT");
    return { result: "UPDATED", ...(proposal ? { proposal } : {}) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
