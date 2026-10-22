import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import type { MarketProposalInput } from "./marketValidation.js";

export type PaidSubmissionIntentResult = {
  submissionId: string;
  proposal: {
    id: string;
    question: string;
    status: "PENDING_APPROVAL";
    submittedAt: string;
  };
  payment: {
    network: "TESTNET";
    token: "USDC";
    tokenAddress: string;
    tokenDecimals: number;
    amountAtomic: string;
    treasuryAddress: string;
    expiresAtMs: number;
  };
};

/**
 * Reserves a quote and creates the proposal + payment record in one transaction.
 * The quote is consumed at intent creation so concurrent/replayed requests cannot
 * create multiple payment intents from one quote.
 */
export async function createPaidSubmissionIntent(input: {
  proposal: MarketProposalInput;
  walletAddress: string;
  quoteId: string;
  treasuryAddress: string;
  nowMs?: number;
}): Promise<PaidSubmissionIntentResult> {
  const client = await database.connect();
  const proposalId = randomUUID();
  const submissionId = randomUUID();
  const wallet = input.walletAddress.toLowerCase();
  try {
    await client.query("BEGIN");
    const quoteResult = await client.query<{
      id: string;
      wallet_address: string;
      token: "USDC";
      token_address: string;
      token_decimals: number;
      amount_atomic: string;
      expires_at_ms: string;
      used_at: string | null;
    }>(
      `SELECT id, wallet_address, token, token_address, token_decimals, amount_atomic,
              expires_at_ms, used_at
       FROM paid_submission_quotes
       WHERE id = $1 AND wallet_address = $2
       FOR UPDATE`,
      [input.quoteId, wallet],
    );
    const quote = quoteResult.rows[0];
    const nowMs = input.nowMs ?? Date.now();
    if (!quote || quote.used_at || Number(quote.expires_at_ms) <= nowMs) {
      throw new Error("Quote is missing, expired, already used, or belongs to another wallet.");
    }

    const reserve = await client.query(
      `UPDATE paid_submission_quotes SET used_at = NOW()
       WHERE id = $1 AND used_at IS NULL AND expires_at_ms > $2
       RETURNING id`,
      [input.quoteId, nowMs],
    );
    if ((reserve.rowCount ?? 0) !== 1) throw new Error("Quote could not be reserved; request a new quote.");

    const proposalResult = await client.query<{
      id: string; question: string; status: "PENDING_APPROVAL"; submittedAt: Date | string;
    }>(
      `INSERT INTO market_proposals
       (id, question, description, category, "closesAt", "resolvesAt", "resolutionRule", "walletAddress", status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_APPROVAL')
       RETURNING id, question, status, "submittedAt"`,
      [proposalId, input.proposal.question, input.proposal.description, input.proposal.category,
       input.proposal.closesAt, input.proposal.resolvesAt, JSON.stringify(input.proposal.resolutionRule), wallet],
    );
    await client.query(
      `INSERT INTO paid_market_submissions
       (id, proposal_id, wallet_address, network, token, amount_atomic, status, quote_id)
       VALUES ($1,$2,$3,'TESTNET',$4,$5,'AWAITING_PAYMENT',$6)`,
      [submissionId, proposalId, wallet, quote.token, quote.amount_atomic, input.quoteId],
    );
    await client.query("COMMIT");
    const proposal = proposalResult.rows[0];
    return {
      submissionId,
      proposal: {
        id: proposal.id,
        question: proposal.question,
        status: proposal.status,
        submittedAt: new Date(proposal.submittedAt).toISOString(),
      },
      payment: {
        network: "TESTNET",
        token: quote.token,
        tokenAddress: quote.token_address,
        tokenDecimals: quote.token_decimals,
        amountAtomic: quote.amount_atomic,
        treasuryAddress: input.treasuryAddress,
        expiresAtMs: Number(quote.expires_at_ms),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPaidSubmissionPaymentContext(input: {
  submissionId: string;
  walletAddress: string;
}): Promise<{
  submissionId: string;
  walletAddress: string;
  status: string;
  paymentTxHash: string | null;
  quote: {
    network: "TESTNET";
    token: "USDC";
    tokenAddress: `0x${string}`;
    tokenDecimals: number;
    amountAtomic: string;
    usdValue: "10.00";
    issuedAtMs: number;
    expiresAtMs: number;
    rateSource: string;
    ngnPerUsd?: number;
  };
} | null> {
  const result = await database.query<{
    id: string; wallet_address: string; status: string; payment_tx_hash: string | null;
    token: "USDC"; token_address: string; token_decimals: number;
    amount_atomic: string; usd_value: string; issued_at_ms: string; expires_at_ms: string;
    rate_source: string; ngn_per_usd: string | null;
  }>(
    `SELECT s.id, s.wallet_address, s.status, s.payment_tx_hash,
            q.token, q.token_address, q.token_decimals, q.amount_atomic,
            q.usd_value, q.issued_at_ms, q.expires_at_ms, q.rate_source, q.ngn_per_usd
     FROM paid_market_submissions s
     JOIN paid_submission_quotes q ON q.id = s.quote_id
     WHERE s.id = $1 AND s.wallet_address = $2`,
    [input.submissionId, input.walletAddress.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    submissionId: row.id,
    walletAddress: row.wallet_address,
    status: row.status,
    paymentTxHash: row.payment_tx_hash,
    quote: {
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
    },
  };
}
