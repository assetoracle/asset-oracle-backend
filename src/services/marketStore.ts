import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import type { MarketProposalInput } from "./marketValidation.js";

export type StoredMarketProposal = MarketProposalInput & {
  id: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  submittedAt: string;
};

type MarketProposalRow = {
  id: string;
  question: string;
  description: string;
  category: string;
  closeAt: string | Date;
  resolveAt: string | Date;
  resolutionRule: string;
  status: StoredMarketProposal["status"];
  submittedAt: string | Date;
};

function mapProposal(row: MarketProposalRow): StoredMarketProposal {
  return {
    id: row.id,
    question: row.question,
    description: row.description,
    category: row.category,
    closeAt: new Date(row.closeAt).toISOString(),
    resolveAt: new Date(row.resolveAt).toISOString(),
    resolutionRule: row.resolutionRule,
    status: row.status,
    submittedAt: new Date(row.submittedAt).toISOString(),
  } as StoredMarketProposal;
}

export async function initializeMarketStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS market_proposals (
      id UUID PRIMARY KEY,
      question TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      "closeAt" TIMESTAMPTZ NOT NULL,
      "resolveAt" TIMESTAMPTZ NOT NULL,
      "resolutionRule" TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
        CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
      "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function createMarketProposal(
  input: MarketProposalInput,
): Promise<StoredMarketProposal> {
  const id = randomUUID();

  const result = await database.query<MarketProposalRow>(
    `INSERT INTO market_proposals
      (id, question, description, category, "closeAt", "resolveAt",
       "resolutionRule", status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_APPROVAL')
     RETURNING *`,
    [
      id,
      input.question,
      input.description,
      input.category,
      input.closeAt,
      input.resolveAt,
      input.resolutionRule,
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
}