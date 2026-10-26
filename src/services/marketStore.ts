import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
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
  origin: "MANUAL" | "AUTOMATED";
  visibility: "PRIVATE" | "PUBLIC";
};

type MarketProposalRow = {
  id: string;
  walletAddress: string | null;
  question: string;
  description: string;
  category: MarketProposalInput["category"];
  sport?: MarketProposalInput["sport"];
  closesAt: string | Date;
  resolvesAt: string | Date;
  resolutionRule: MarketProposalInput["resolutionRule"];
  status: StoredMarketProposal["status"];
  submittedAt: string | Date;
  onchain_market_id?: string | null;
  onchain_tx_hash?: string | null;
  onchain_manager_address?: string | null;
  onchain_chain_id?: number | null;
  origin?: "MANUAL" | "AUTOMATED";
  visibility?: "PRIVATE" | "PUBLIC";
};

function mapProposal(row: MarketProposalRow): StoredMarketProposal {
  return {
    id: row.id,
    walletAddress: row.walletAddress,
    question: row.question,
    description: row.description,
    category: row.category,
    ...(row.sport ? { sport: row.sport } : {}),
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
    origin: row.origin ?? "MANUAL",
    visibility: row.visibility ?? "PRIVATE",
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
      ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'MANUAL',
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'PRIVATE'
  `);
  await database.query(`
    ALTER TABLE market_proposals DROP CONSTRAINT IF EXISTS market_proposals_origin_check
  `);
  await database.query(`
    ALTER TABLE market_proposals ADD CONSTRAINT market_proposals_origin_check
      CHECK (origin IN ('MANUAL', 'AUTOMATED'))
  `);
  await database.query(`
    ALTER TABLE market_proposals DROP CONSTRAINT IF EXISTS market_proposals_visibility_check
  `);
  await database.query(`
    ALTER TABLE market_proposals ADD CONSTRAINT market_proposals_visibility_check
      CHECK (visibility IN ('PRIVATE', 'PUBLIC'))
  `);
  await database.query(`
    ALTER TABLE market_proposals
    ADD COLUMN IF NOT EXISTS sport TEXT
  `);
  await database.query(`
    ALTER TABLE market_proposals
      ADD COLUMN IF NOT EXISTS onchain_market_id TEXT,
      ADD COLUMN IF NOT EXISTS onchain_tx_hash TEXT,
      ADD COLUMN IF NOT EXISTS onchain_manager_address TEXT,
      ADD COLUMN IF NOT EXISTS onchain_chain_id INTEGER
  `);
  await database.query(`
    UPDATE market_proposals
       SET visibility = 'PUBLIC'
     WHERE status = 'APPROVED'
       AND onchain_market_id ~ '^[1-9][0-9]*$'
       AND onchain_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
       AND onchain_manager_address ~ '^0x[0-9a-fA-F]{40}$'
       AND onchain_chain_id = 42421
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
  client?: PoolClient,
): Promise<StoredMarketProposal> {
  const executor = client ?? database;
  const result = await executor.query<MarketProposalRow>(
    `INSERT INTO market_proposals
  (id, question, description, category, sport, "closesAt", "resolvesAt",
   "resolutionRule", "walletAddress", status)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_APPROVAL')
 RETURNING *`,
    [
  randomUUID(),
  input.question,
  input.description,
  input.category,
  input.sport ?? null,
  input.closesAt,
  input.resolvesAt,
  JSON.stringify(input.resolutionRule),
  walletAddress.toLowerCase(),
],
  );

  return mapProposal(result.rows[0]);
}

/** API-ingested markets are private and await approval by one authorized market maker. */
export async function createAutomatedMarketProposal(input: MarketProposalInput): Promise<StoredMarketProposal> {
  const result = await database.query<MarketProposalRow>(
    `INSERT INTO market_proposals
      (id, question, description, category, sport, "closesAt", "resolvesAt",
       "resolutionRule", "walletAddress", status, origin, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 'PENDING_APPROVAL', 'AUTOMATED', 'PRIVATE')
     RETURNING *`,
    [randomUUID(), input.question, input.description, input.category, input.sport ?? null,
      input.closesAt, input.resolvesAt, JSON.stringify(input.resolutionRule)],
  );
  return mapProposal(result.rows[0]);
}

/** Any one owner or configured market maker may decide an automated API market. */
export async function decideAutomatedMarketProposal(
  id: string,
  decision: "APPROVED" | "REJECTED",
): Promise<StoredMarketProposal | undefined> {
  const result = await database.query<MarketProposalRow>(
    `UPDATE market_proposals
        SET status = $2,
            visibility = CASE
              WHEN $2 = 'APPROVED'
               AND onchain_market_id ~ '^[1-9][0-9]*$'
               AND onchain_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
               AND onchain_manager_address ~ '^0x[0-9a-fA-F]{40}$'
               AND onchain_chain_id = 42421
              THEN 'PUBLIC'
              ELSE 'PRIVATE'
            END
      WHERE id = $1
        AND origin = 'AUTOMATED'
        AND status = 'PENDING_APPROVAL'
      RETURNING *`,
    [id, decision],
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}

export async function listAutomatedMarketProposals(): Promise<StoredMarketProposal[]> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals
      WHERE origin = 'AUTOMATED' AND visibility = 'PRIVATE'
      ORDER BY "submittedAt" DESC`,
  );
  return result.rows.map(mapProposal);
}

export async function updateOwnedMarketProposal(
  id: string,
  walletAddress: string,
  input: MarketProposalInput,
): Promise<StoredMarketProposal | undefined> {
  const result = await database.query<MarketProposalRow>(
    `UPDATE market_proposals
     SET question = $3,
         description = $4,
         category = $5,
         sport = $6,
         "closesAt" = $7,
         "resolvesAt" = $8,
         "resolutionRule" = $9,
         status = 'PENDING_APPROVAL',
         "submittedAt" = NOW()
     WHERE id = $1
       AND lower("walletAddress") = lower($2)
       AND onchain_tx_hash IS NULL
       AND onchain_market_id IS NULL
     RETURNING *`,
    [
      id,
      walletAddress,
      input.question,
      input.description,
      input.category,
      input.sport ?? null,
      input.closesAt,
      input.resolvesAt,
      JSON.stringify(input.resolutionRule),
    ],
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}

export async function listMarketProposals(): Promise<StoredMarketProposal[]> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals WHERE origin = 'MANUAL' ORDER BY "submittedAt" DESC`,
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
     WHERE status = 'APPROVED'
       AND onchain_market_id ~ '^[1-9][0-9]*$'
       AND onchain_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
       AND onchain_manager_address ~ '^0x[0-9a-fA-F]{40}$'
       AND onchain_chain_id = 42421
       AND visibility = 'PUBLIC'
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

  let result;
  try {
    result = await database.query<MarketProposalRow>(
      `UPDATE market_proposals
       SET onchain_market_id = $2,
           onchain_tx_hash = $3,
           onchain_manager_address = $4,
           onchain_chain_id = $5,
           visibility = CASE WHEN status = 'APPROVED' AND $5 = 42421 THEN 'PUBLIC' ELSE 'PRIVATE' END
       WHERE id = $1 AND status = 'APPROVED' AND onchain_tx_hash IS NULL
       RETURNING *`,
      [input.id, input.marketId, input.txHash.toLowerCase(), input.managerAddress.toLowerCase(), input.chainId],
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
        (error as { code?: string }).code === "23505") {
      throw new Error("On-chain market or transaction is already recorded for another proposal.");
    }
    throw error;
  }
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
     SET status = $2,
         visibility = 'PRIVATE'
     WHERE id = $1
       AND status = 'PENDING_APPROVAL'
     RETURNING *`,
    [id, status],
  );

  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}
