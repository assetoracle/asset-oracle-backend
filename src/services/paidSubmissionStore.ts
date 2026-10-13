import { database } from "../config/database.js";
import { awardLeaderboardPoints } from "./pointsStore.js";

export type SubmissionNetwork = "MAINNET" | "TESTNET";
export type SubmissionToken = "USDC" | "USDT" | "cNGN";
export type PaidSubmissionStatus =
  | "AWAITING_PAYMENT"
  | "PAID_PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED_REFUND_PENDING"
  | "REFUNDED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "PUBLICATION_RETRY_REQUIRED"
  | "REFUND_FAILED";

export type PaidSubmission = {
  id: string;
  proposalId: string;
  walletAddress: string;
  network: SubmissionNetwork;
  token: SubmissionToken;
  amountAtomic: string;
  status: PaidSubmissionStatus;
  paymentTxHash: string | null;
  refundTxHash: string | null;
  publishedMarketId: string | null;
};

const TOKEN_SET: Record<SubmissionNetwork, readonly SubmissionToken[]> = {
  MAINNET: ["USDC", "USDT", "cNGN"],
  TESTNET: ["USDC"],
};

/** Resolve the allowed fee token before creating a payment intent. Amounts are atomic units. */
export function validateSubmissionPayment(input: {
  network: SubmissionNetwork;
  token: SubmissionToken;
  amountAtomic: string;
  expectedAmountAtomic: string;
}): void {
  if (!TOKEN_SET[input.network]?.includes(input.token)) {
    throw new Error("This stablecoin is not enabled for paid submissions on the selected network.");
  }
  if (!/^[1-9][0-9]*$/.test(input.amountAtomic) ||
      !/^[1-9][0-9]*$/.test(input.expectedAmountAtomic) ||
      input.amountAtomic !== input.expectedAmountAtomic) {
    throw new Error("Payment amount does not match the verified $10-equivalent quote.");
  }
}

export async function initializePaidSubmissionStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS paid_market_submissions (
      id UUID PRIMARY KEY,
      proposal_id UUID NOT NULL UNIQUE REFERENCES market_proposals(id),
      wallet_address TEXT NOT NULL,
      network TEXT NOT NULL CHECK (network IN ('MAINNET', 'TESTNET')),
      token TEXT NOT NULL CHECK (token IN ('USDC', 'USDT', 'cNGN')),
      amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
      status TEXT NOT NULL CHECK (status IN (
        'AWAITING_PAYMENT', 'PAID_PENDING_REVIEW', 'APPROVED',
        'REJECTED_REFUND_PENDING', 'REFUNDED', 'PUBLISHING', 'PUBLISHED',
        'PUBLICATION_RETRY_REQUIRED', 'REFUND_FAILED'
      )),
      payment_tx_hash TEXT UNIQUE,
      refund_tx_hash TEXT UNIQUE,
      published_market_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (network <> 'TESTNET' OR token = 'USDC')
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS paid_market_submissions_status_idx
    ON paid_market_submissions (status, created_at)
  `);
}

/**
 * Record payment only after the caller verifies the receipt, sender, recipient,
 * chain, token contract, token decimals, amount and finality against trusted RPC data.
 * The unique transaction hash makes payment confirmation idempotent.
 */
export async function recordConfirmedSubmissionPayment(input: {
  id: string;
  paymentTxHash: string;
}): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.paymentTxHash)) {
    throw new Error("A valid confirmed payment transaction hash is required.");
  }
  const result = await database.query(
    `UPDATE paid_market_submissions
     SET status = 'PAID_PENDING_REVIEW', payment_tx_hash = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'AWAITING_PAYMENT' AND payment_tx_hash IS NULL
     RETURNING id`,
    [input.id, input.paymentTxHash.toLowerCase()],
  );
  if ((result.rowCount ?? result.rows.length) > 0) return;

  const existing = await database.query<{ status: string; payment_tx_hash: string | null }>(
    "SELECT status, payment_tx_hash FROM paid_market_submissions WHERE id = $1",
    [input.id],
  );
  if (existing.rows[0]?.payment_tx_hash?.toLowerCase() === input.paymentTxHash.toLowerCase() &&
      existing.rows[0].status !== "AWAITING_PAYMENT") return;
  if (!existing.rows[0]) throw new Error("Paid submission not found.");
  throw new Error("Submission is not awaiting payment or the payment was already recorded differently.");
}

/** Only an admin-reviewed rejection can enter the refund queue. */
export async function queueSubmissionRefund(id: string): Promise<void> {
  const result = await database.query(
    `UPDATE paid_market_submissions SET status = 'REJECTED_REFUND_PENDING', updated_at = NOW()
     WHERE id = $1 AND status = 'PAID_PENDING_REVIEW' RETURNING id`,
    [id],
  );
  if ((result.rowCount ?? result.rows.length) > 0) return;
  const existing = await database.query<{ status: string }>(
    "SELECT status FROM paid_market_submissions WHERE id = $1", [id],
  );
  if (existing.rows[0]?.status === "REJECTED_REFUND_PENDING" ||
      existing.rows[0]?.status === "REFUNDED") return;
  if (!existing.rows[0]) throw new Error("Paid submission not found.");
  throw new Error("Only a paid submission pending review can be rejected for refund.");
}

/** Record a refund only after independently verifying the successful on-chain transfer. */
export async function recordSubmissionRefund(input: { id: string; refundTxHash: string }): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.refundTxHash)) {
    throw new Error("A valid confirmed refund transaction hash is required.");
  }
  const result = await database.query(
    `UPDATE paid_market_submissions SET status = 'REFUNDED', refund_tx_hash = $2, updated_at = NOW()
     WHERE id = $1 AND status IN ('REJECTED_REFUND_PENDING', 'REFUND_FAILED')
       AND refund_tx_hash IS NULL RETURNING id`,
    [input.id, input.refundTxHash.toLowerCase()],
  );
  if ((result.rowCount ?? result.rows.length) > 0) return;
  const existing = await database.query<{ status: string; refund_tx_hash: string | null }>(
    "SELECT status, refund_tx_hash FROM paid_market_submissions WHERE id = $1", [input.id],
  );
  if (existing.rows[0]?.refund_tx_hash?.toLowerCase() === input.refundTxHash.toLowerCase() &&
      existing.rows[0].status === "REFUNDED") return;
  if (!existing.rows[0]) throw new Error("Paid submission not found.");
  throw new Error("Submission is not awaiting refund or a different refund is already recorded.");
}

/** A publication failure stays recoverable and never silently charges the creator again. */
export async function markPublicationRetryRequired(id: string): Promise<void> {
  const result = await database.query(
    `UPDATE paid_market_submissions SET status = 'PUBLICATION_RETRY_REQUIRED', updated_at = NOW()
     WHERE id = $1 AND status IN ('APPROVED', 'PUBLISHING', 'PUBLICATION_RETRY_REQUIRED')
     RETURNING id`,
    [id],
  );
  if ((result.rowCount ?? result.rows.length) > 0) return;
  const existing = await database.query<{ status: string }>(
    "SELECT status FROM paid_market_submissions WHERE id = $1", [id],
  );
  if (!existing.rows[0]) throw new Error("Paid submission not found.");
  throw new Error("Only an approved submission can be queued for publication retry.");
}

export async function markSubmissionPublished(input: { id: string; marketId: string }): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(input.marketId)) throw new Error("A valid on-chain market ID is required.");
  const result = await database.query(
    `UPDATE paid_market_submissions SET status = 'PUBLISHED', published_market_id = $2, updated_at = NOW()
     WHERE id = $1 AND status IN ('APPROVED', 'PUBLISHING', 'PUBLICATION_RETRY_REQUIRED')
       AND published_market_id IS NULL RETURNING id`,
    [input.id, input.marketId],
  );
  let published = (result.rowCount ?? result.rows.length) > 0;
  if (!published) {
    const existing = await database.query<{ status: string; published_market_id: string | null }>(
      "SELECT status, published_market_id FROM paid_market_submissions WHERE id = $1", [input.id],
    );
    published = existing.rows[0]?.status === "PUBLISHED" && existing.rows[0].published_market_id === input.marketId;
    if (!existing.rows[0]) throw new Error("Paid submission not found.");
    if (!published) throw new Error("Submission cannot be marked published from its current state.");
  }

  // Award only after publication is confirmed in the lifecycle store. Stable event key
  // makes retries safe if the database update succeeded but the points write failed.
  const submission = await database.query<{ wallet_address: string; proposal_id: string }>(
    "SELECT wallet_address, proposal_id FROM paid_market_submissions WHERE id = $1 AND status = 'PUBLISHED' AND published_market_id = $2",
    [input.id, input.marketId],
  );
  if (!submission.rows[0]) throw new Error("Published submission could not be reloaded for its points award.");
  await awardLeaderboardPoints({
    walletAddress: submission.rows[0].wallet_address,
    eventType: "PAID_MARKET_SUBMISSION",
    eventKey: `paid-submission:${input.id}`,
    points: 50,
    metadata: { submissionId: input.id, proposalId: submission.rows[0].proposal_id, marketId: input.marketId },
  });
}


/**
 * Keep paid-submission review state aligned with the admin decision for its proposal.
 * A paid proposal cannot be approved/rejected until payment has been confirmed.
 */
export async function recordPaidSubmissionDecisionForProposal(
  proposalId: string,
  decision: "APPROVED" | "REJECTED",
): Promise<boolean> {
  const lookup = await database.query<{ id: string; status: PaidSubmissionStatus }>(
    "SELECT id, status FROM paid_market_submissions WHERE proposal_id = $1",
    [proposalId],
  );
  const submission = lookup.rows[0];
  if (!submission) return false; // Ordinary, non-paid proposal.
  if (submission.status !== "PAID_PENDING_REVIEW") {
    throw new Error("Paid submission must have confirmed payment and be pending review before an admin decision.");
  }
  const nextStatus = decision === "APPROVED" ? "APPROVED" : "REJECTED_REFUND_PENDING";
  const updated = await database.query(
    "UPDATE paid_market_submissions SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'PAID_PENDING_REVIEW' RETURNING id",
    [submission.id, nextStatus],
  );
  if ((updated.rowCount ?? updated.rows.length) === 0) {
    const current = await database.query<{ status: PaidSubmissionStatus }>(
      "SELECT status FROM paid_market_submissions WHERE id = $1", [submission.id],
    );
    if (current.rows[0]?.status !== nextStatus) {
      throw new Error("Paid submission review state changed concurrently; reload and retry.");
    }
  }
  return true;
}

/** Award 50 points only when a verified publication is linked to a paid proposal. */
export async function markPaidSubmissionPublishedForProposal(input: {
  proposalId: string;
  marketId: string;
}): Promise<boolean> {
  const result = await database.query<{ id: string }>(
    "SELECT id FROM paid_market_submissions WHERE proposal_id = $1",
    [input.proposalId],
  );
  if (!result.rows[0]) return false;
  await markSubmissionPublished({ id: result.rows[0].id, marketId: input.marketId });
  return true;
}
