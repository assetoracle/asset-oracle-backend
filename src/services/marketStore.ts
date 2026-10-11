import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import type { MarketProposalInput } from "./marketValidation.js";

export type StoredMarketProposal = MarketProposalInput & {
  id: string;
  walletAddress?: string | null;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  submittedAt: string;
  onchainMarketId?: string | null;
  onchainTxHash?: string | null;
  onchainManagerAddress?: string | null;
  onchainChainId?: number | null;
};

type MarketProposalRow = {
  id: string;
  walletAddress: string | null;
  question: string;
  description: string;
  category: MarketProposalInput["category"];
  closesAt: string | Date;
  resolvesAt: string | Date;
  resolutionRule: MarketProposalInput["resolutionRule"];
  status: StoredMarketProposal["status"];
  submittedAt: string | Date;
  onchain_market_id?: string | null;
  onchain_tx_hash?: string | null;
  onchain_manager_address?: string | null;
  onchain_chain_id?: number | null;
};

function mapProposal(row: MarketProposalRow): StoredMarketProposal {
  return {
    id: row.id,
    walletAddress: row.walletAddress,
    question: row.question,
    description: row.description,
    category: row.category,
    closesAt: new Date(row.closesAt).toISOString(),
    resolvesAt: new Date(row.resolvesAt).toISOString(),
    resolutionRule:
      typeof row.resolutionRule === "string"
        ? JSON.parse(row.resolutionRule)
        : row.resolutionRule,
    status: row.status,
    submittedAt: new Date(row.submittedAt).toISOString(),
    onchainMarketId: row.onchain_market_id ?? null,
    onchainTxHash: row.onchain_tx_hash ?? null,
    onchainManagerAddress: row.onchain_manager_address ?? null,
    onchainChainId: row.onchain_chain_id ?? null,
  };
}

export async function initializeMarketStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_proposals (
      id UUID PRIMARY KEY,
      question TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      "closesAt" TIMESTAMPTZ NOT NULL,
      "resolvesAt" TIMESTAMPTZ NOT NULL,
      "resolutionRule" JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
        CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
      "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    ALTER TABLE market_proposals
    ADD COLUMN IF NOT EXISTS "walletAddress" TEXT
  `);
  await database.query(`
    ALTER TABLE market_proposals
      ADD COLUMN IF NOT EXISTS onchain_market_id TEXT,
      ADD COLUMN IF NOT EXISTS onchain_tx_hash TEXT,
      ADD COLUMN IF NOT EXISTS onchain_manager_address TEXT,
      ADD COLUMN IF NOT EXISTS onchain_chain_id INTEGER
  `);
  await database.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS market_proposals_onchain_tx_hash_unique
    ON market_proposals (onchain_tx_hash) WHERE onchain_tx_hash IS NOT NULL
  `);
  await database.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS market_proposals_onchain_market_unique
    ON market_proposals (onchain_chain_id, lower(onchain_manager_address), onchain_market_id)
    WHERE onchain_market_id IS NOT NULL AND onchain_manager_address IS NOT NULL
  `);
}

export async function createMarketProposal(
  input: MarketProposalInput,
  walletAddress: string,
): Promise<StoredMarketProposal> {
  const result = await database.query<MarketProposalRow>(
    `INSERT INTO market_proposals
  (id, question, description, category, "closesAt", "resolvesAt",
   "resolutionRule", "walletAddress", status)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_APPROVAL')
 RETURNING *`,
    [
  randomUUID(),
  input.question,
  input.description,
  input.category,
  input.closesAt,
  input.resolvesAt,
  JSON.stringify(input.resolutionRule),
  walletAddress.toLowerCase(),
],
  );

  return mapProposal(result.rows[0]);
}

export async function listMarketProposals(): Promise<StoredMarketProposal[]> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals ORDER BY "submittedAt" DESC`,
  );

  return result.rows.map(mapProposal);
}

export async function getMarketProposal(
  id: string,
): Promise<StoredMarketProposal | undefined> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals WHERE id = $1`,
    [id],
  );

  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}export async function listPublishedMarkets(): Promise<
  StoredMarketProposal[]
> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals
     WHERE status = 'APPROVED' AND onchain_tx_hash IS NOT NULL
     ORDER BY "submittedAt" DESC`,
  );

  return result.rows.map(mapProposal);
}

export async function recordOnchainPublication(input: {
  id: string;
  marketId: string;
  txHash: string;
  managerAddress: string;
  chainId: number;
}): Promise<StoredMarketProposal | undefined> {
  const existing = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals WHERE id = $1`,
    [input.id],
  );
  if (!existing.rows[0]) return undefined;
  const row = existing.rows[0] as MarketProposalRow & {
    onchain_tx_hash?: string | null;
    onchain_market_id?: string | null;
  };
  if (row.onchain_tx_hash) {
    if (row.onchain_tx_hash.toLowerCase() === input.txHash.toLowerCase() &&
        row.onchain_market_id === input.marketId) {
      return mapProposal(row);
    }
    throw new Error("Proposal already has a recorded on-chain publication.");
  }

  const result = await database.query<MarketProposalRow>(
    `UPDATE market_proposals
     SET onchain_market_id = $2,
         onchain_tx_hash = $3,
         onchain_manager_address = $4,
         onchain_chain_id = $5
     WHERE id = $1 AND status = 'APPROVED' AND onchain_tx_hash IS NULL
     RETURNING *`,
    [input.id, input.marketId, input.txHash.toLowerCase(), input.managerAddress.toLowerCase(), input.chainId],
  );
  if (result.rows[0]) return mapProposal(result.rows[0]);

  const latest = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals WHERE id = $1`,
    [input.id],
  );
  if (latest.rows[0]) {
    const latestRow = latest.rows[0] as MarketProposalRow & { onchain_tx_hash?: string | null; onchain_market_id?: string | null };
    if (latestRow.onchain_tx_hash?.toLowerCase() === input.txHash.toLowerCase() &&
        latestRow.onchain_market_id === input.marketId) return mapProposal(latestRow);
    if (latestRow.onchain_tx_hash) throw new Error("Proposal already has a recorded on-chain publication.");
  }
  return undefined;
}

export async function listMarketProposalsByWallet(
  walletAddress: string,
): Promise<StoredMarketProposal[]> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals
     WHERE "walletAddress" = $1
     ORDER BY "submittedAt" DESC`,
    [walletAddress.toLowerCase()],
  );

  return result.rows.map(mapProposal);
}

export async function updateMarketProposalStatus(
  id: string,
  status: "APPROVED" | "REJECTED",
): Promise<StoredMarketProposal | undefined> {
  const result = await database.query<MarketProposalRow>(
    `UPDATE market_proposals
     SET status = $2
     WHERE id = $1
       AND status = 'PENDING_APPROVAL'
     RETURNING *`,
    [id, status],
  );

  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}
