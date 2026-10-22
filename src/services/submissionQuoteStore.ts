import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import type { SubmissionQuote } from "./paidSubmissionQuote.js";

export type StoredSubmissionQuote = SubmissionQuote & {
  id: string;
  walletAddress: string;
  usedAt: string | null;
};

export async function initializeSubmissionQuoteStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS paid_submission_quotes (
      id UUID PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      network TEXT NOT NULL CHECK (network = 'TESTNET'),
      token TEXT NOT NULL CHECK (token = 'USDC'),
      token_address TEXT NOT NULL,
      token_decimals INTEGER NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
      amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
      usd_value NUMERIC(10, 2) NOT NULL CHECK (usd_value = 10.00),
      issued_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > issued_at_ms),
      rate_source TEXT NOT NULL,
      ngn_per_usd NUMERIC,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`CREATE INDEX IF NOT EXISTS paid_submission_quotes_wallet_idx ON paid_submission_quotes(wallet_address, created_at DESC)`);
}

export async function persistSubmissionQuote(input: {
  walletAddress: string;
  quote: SubmissionQuote;
}): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO paid_submission_quotes
      (id, wallet_address, network, token, token_address, token_decimals, amount_atomic,
       usd_value, issued_at_ms, expires_at_ms, rate_source, ngn_per_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, input.walletAddress.toLowerCase(), input.quote.network, input.quote.token,
      input.quote.tokenAddress, input.quote.tokenDecimals, input.quote.amountAtomic,
      input.quote.usdValue, input.quote.issuedAtMs, input.quote.expiresAtMs,
      input.quote.rateSource, input.quote.ngnPerUsd ?? null],
  );
  return id;
}

/** Load a quote only for its authenticated owner and only while unexpired. */
export async function getActiveSubmissionQuote(input: {
  quoteId: string;
  walletAddress: string;
  nowMs?: number;
}): Promise<StoredSubmissionQuote | null> {
  const result = await database.query<{
    id: string; wallet_address: string; token: "USDC";
    token_address: string; token_decimals: number; amount_atomic: string;
    usd_value: string; issued_at_ms: string; expires_at_ms: string;
    rate_source: string; ngn_per_usd: string | null; used_at: string | null;
  }>(
    `SELECT id, wallet_address, token, token_address, token_decimals, amount_atomic,
       usd_value, issued_at_ms, expires_at_ms, rate_source, ngn_per_usd, used_at
     FROM paid_submission_quotes
     WHERE id = $1 AND wallet_address = $2 AND used_at IS NULL AND expires_at_ms > $3`,
    [input.quoteId, input.walletAddress.toLowerCase(), input.nowMs ?? Date.now()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    network: "TESTNET",
    token: row.token,
    tokenAddress: row.token_address as `0x${string}`,
    tokenDecimals: row.token_decimals,
    amountAtomic: row.amount_atomic,
    usdValue: row.usd_value as "10.00",
    issuedAtMs: Number(row.issued_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    rateSource: row.rate_source,
    ...(row.ngn_per_usd === null ? {} : { ngnPerUsd: Number(row.ngn_per_usd) }),
    usedAt: row.used_at,
  };
}
