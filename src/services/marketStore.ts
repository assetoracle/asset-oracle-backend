import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import type { MarketProposalInput } from "./marketValidation.js";

export type StoredMarketProposal = MarketProposalInput & {
  id: string;
  walletAddress?: string | null;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  submittedAt: string;
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
     WHERE status = 'APPROVED'
     ORDER BY "submittedAt" DESC`,
  );

  return result.rows.map(mapProposal);
}