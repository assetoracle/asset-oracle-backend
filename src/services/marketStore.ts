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
  category: string;
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

function normalizeMarketCategory(category: string): MarketProposalInput["category"] {
  if (category === "Crypto" || category === "Digital Assets") return "Digital Assets";
  if (category === "Sports" || category === "Economics" || category === "RWA" || category === "Regional") return category;
  throw new Error(`Unsupported stored market category: ${category}`);
}

function mapProposal(row: MarketProposalRow): StoredMarketProposal {
  return {
    id: row.id,
    walletAddress: row.walletAddress,
    question: row.question,
    description: row.description,
    category: normalizeMarketCategory(row.category),
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
  // Automated proposals have no submitting wallet; preserve compatibility with
  // databases created by earlier schemas where this column was NOT NULL.
  await database.query(`
    ALTER TABLE market_proposals
    ALTER COLUMN "walletAddress" DROP NOT NULL
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
  // Fail closed on startup: stored metadata alone is not proof of a valid on-chain
  // publication. Public visibility is set only by the publication route after it
  // verifies the receipt, manager, MarketCreated event, and actual market type.
  await database.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS market_proposals_onchain_tx_hash_unique
    ON market_proposals (onchain_tx_hash) WHERE onchain_tx_hash IS NOT NULL
  `);
  await database.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS market_proposals_onchain_market_unique
    ON market_proposals (onchain_chain_id, lower(onchain_manager_address), onchain_market_id)
    WHERE onchain_market_id IS NOT NULL AND onchain_manager_address IS NOT NULL
  `);
  // Additive lifecycle migration: record each publication attempt before broadcasting.
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_publish_attempts (
      id BIGSERIAL PRIMARY KEY,
      proposal_id UUID NOT NULL REFERENCES market_proposals(id) ON DELETE CASCADE,
      chain_id INTEGER NOT NULL CHECK (chain_id = 42421),
      manager_address TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status TEXT NOT NULL CHECK (status IN ('PREPARED', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'PUBLISHED', 'FAILED')),
      transaction_hash TEXT,
      market_id TEXT,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (proposal_id, chain_id, manager_address, attempt_number)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS market_publish_attempts_recovery_idx
    ON market_publish_attempts (chain_id, manager_address, status, proposal_id)
    WHERE status IN ('PREPARED', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'PUBLISHED')
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_store_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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
export async function createAutomatedMarketProposal(input: MarketProposalInput, client?: PoolClient): Promise<StoredMarketProposal> {
  const executor = client ?? database;
  const result = await executor.query<MarketProposalRow>(
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
            visibility = 'PRIVATE'
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

/** Approved proposals of either origin, exposed only to the owner for evidence collection. */
export async function listApprovedMarketProposalsForEvidence(): Promise<StoredMarketProposal[]> {
  const result = await database.query<MarketProposalRow>(
    `SELECT * FROM market_proposals
      WHERE status = 'APPROVED'
      ORDER BY "submittedAt" DESC`,
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


export type MarketPublicationAttemptStatus =
  | "PREPARED"
  | "SUBMITTED"
  | "RECONCILIATION_REQUIRED"
  | "PUBLISHED"
  | "FAILED";

export type MarketPublicationAttempt = {
  id: number;
  proposalId: string;
  chainId: number;
  managerAddress: string;
  attemptNumber: number;
  status: MarketPublicationAttemptStatus;
  transactionHash: string | null;
  marketId: string | null;
  failureReason: string | null;
};

type MarketPublicationAttemptRow = {
  id: number;
  proposal_id: string;
  chain_id: number;
  manager_address: string;
  attempt_number: number;
  status: MarketPublicationAttemptStatus;
  transaction_hash: string | null;
  market_id: string | null;
  failure_reason: string | null;
};

function mapPublicationAttempt(row: MarketPublicationAttemptRow): MarketPublicationAttempt {
  return {
    id: Number(row.id),
    proposalId: row.proposal_id,
    chainId: Number(row.chain_id),
    managerAddress: row.manager_address,
    attemptNumber: Number(row.attempt_number),
    status: row.status,
    transactionHash: row.transaction_hash,
    marketId: row.market_id,
    failureReason: row.failure_reason,
  };
}

/** One-time compatibility migration: legacy approved proposals may have been broadcast before attempts were tracked. */
export async function seedLegacyMarketPublicationAttempts(input: {
  chainId: number;
  managerAddress: string;
}): Promise<number> {
  if (input.chainId !== 42421) throw new Error("Legacy publication reconciliation is restricted to Enugu testnet (42421).");
  const client = await database.connect();
  const migrationKey = `legacy_market_publication_attempts_${input.chainId}_${input.managerAddress.toLowerCase()}`;
  try {
    await client.query("BEGIN");
    const migration = await client.query(
      "INSERT INTO market_store_migrations (migration_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING migration_key",
      [migrationKey],
    );
    if (migration.rows.length === 0) {
      await client.query("COMMIT");
      return 0;
    }
    const seeded = await client.query(
      `INSERT INTO market_publish_attempts
        (proposal_id, chain_id, manager_address, attempt_number, status, failure_reason)
       SELECT id, $1, lower($2), 1, 'RECONCILIATION_REQUIRED',
              'Legacy proposal: verify prior on-chain publication before retrying.'
         FROM market_proposals
        WHERE status = 'APPROVED'
          AND onchain_tx_hash IS NULL
          AND onchain_market_id IS NULL
       ON CONFLICT (proposal_id, chain_id, manager_address, attempt_number) DO NOTHING
       RETURNING id`,
      [input.chainId, input.managerAddress],
    );
    await client.query("COMMIT");
    return seeded.rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestMarketPublicationAttempt(input: {
  proposalId: string;
  chainId: number;
  managerAddress: string;
}): Promise<MarketPublicationAttempt | undefined> {
  const result = await database.query<MarketPublicationAttemptRow>(
    `SELECT id, proposal_id, chain_id, manager_address, attempt_number, status,
            transaction_hash, market_id, failure_reason
       FROM market_publish_attempts
      WHERE proposal_id = $1 AND chain_id = $2 AND manager_address = lower($3)
      ORDER BY attempt_number DESC LIMIT 1`,
    [input.proposalId, input.chainId, input.managerAddress],
  );
  return result.rows[0] ? mapPublicationAttempt(result.rows[0]) : undefined;
}

/** Create a durable PREPARED record before the wallet client can broadcast a transaction. */
export async function createMarketPublicationAttempt(input: {
  proposalId: string;
  chainId: number;
  managerAddress: string;
}): Promise<MarketPublicationAttempt> {
  const result = await database.query<MarketPublicationAttemptRow>(
    `INSERT INTO market_publish_attempts
       (proposal_id, chain_id, manager_address, attempt_number, status)
     SELECT $1, $2, lower($3), COALESCE(MAX(attempt_number), 0) + 1, 'PREPARED'
       FROM market_publish_attempts
      WHERE proposal_id = $1 AND chain_id = $2 AND manager_address = lower($3)
     RETURNING id, proposal_id, chain_id, manager_address, attempt_number, status,
               transaction_hash, market_id, failure_reason`,
    [input.proposalId, input.chainId, input.managerAddress],
  );
  if (!result.rows[0]) throw new Error(`Unable to create publication attempt for proposal ${input.proposalId}.`);
  return mapPublicationAttempt(result.rows[0]);
}

export async function updateMarketPublicationAttempt(input: {
  id: number;
  status: MarketPublicationAttemptStatus;
  transactionHash?: string | null;
  marketId?: string | null;
  failureReason?: string | null;
}): Promise<void> {
  const result = await database.query(
    `UPDATE market_publish_attempts
        SET status = $2,
            transaction_hash = COALESCE($3, transaction_hash),
            market_id = COALESCE($4, market_id),
            failure_reason = $5,
            updated_at = NOW()
      WHERE id = $1`,
    [input.id, input.status, input.transactionHash ?? null, input.marketId ?? null, input.failureReason ?? null],
  );
  if (result.rowCount === 0) throw new Error(`Publication attempt ${input.id} was not found while updating its state.`);
}
