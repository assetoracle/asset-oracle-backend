import { database } from "../config/database.js";

export async function decidePaidMarketProposalAtomically(input: {
  proposalId: string;
  decision: "APPROVED" | "REJECTED";
  decisionTxHash: string;
}): Promise<"UPDATED" | "NOT_FOUND" | "CONFLICT"> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.decisionTxHash)) {
    throw new Error("A valid confirmed escrow decision transaction hash is required.");
  }

  // Additive migration for existing installations. The unique index prevents
  // one escrow decision receipt from being attached to multiple proposals.
  await database.query("ALTER TABLE paid_market_submissions ADD COLUMN IF NOT EXISTS decision_tx_hash TEXT");
  await database.query("CREATE UNIQUE INDEX IF NOT EXISTS paid_market_submissions_decision_tx_hash_unique ON paid_market_submissions (decision_tx_hash) WHERE decision_tx_hash IS NOT NULL");

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const proposalResult = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM market_proposals WHERE id = $1 AND origin = 'MANUAL' FOR UPDATE",
      [input.proposalId],
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) {
      await client.query("ROLLBACK");
      return "NOT_FOUND";
    }
    if (proposal.status !== "PENDING_APPROVAL") {
      await client.query("ROLLBACK");
      return "CONFLICT";
    }

    const paidResult = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM paid_market_submissions WHERE proposal_id = $1 FOR UPDATE",
      [input.proposalId],
    );
    const paid = paidResult.rows[0];
    if (!paid || paid.status !== "PAID_PENDING_REVIEW") {
      await client.query("ROLLBACK");
      return "CONFLICT";
    }

    const nextPaidStatus = input.decision === "APPROVED" ? "APPROVED" : "REFUNDED";
    const paidUpdate = await client.query(
      "UPDATE paid_market_submissions SET status = $2, decision_tx_hash = $3, updated_at = NOW() WHERE id = $1 AND status = 'PAID_PENDING_REVIEW' AND decision_tx_hash IS NULL RETURNING id",
      [paid.id, nextPaidStatus, input.decisionTxHash.toLowerCase()],
    );
    if ((paidUpdate.rowCount ?? paidUpdate.rows.length) !== 1) {
      await client.query("ROLLBACK");
      return "CONFLICT";
    }

    const proposalUpdate = await client.query(
      "UPDATE market_proposals SET status = $2 WHERE id = $1 AND status = 'PENDING_APPROVAL' RETURNING id",
      [input.proposalId, input.decision],
    );
    if ((proposalUpdate.rowCount ?? proposalUpdate.rows.length) !== 1) {
      await client.query("ROLLBACK");
      return "CONFLICT";
    }

    await client.query("COMMIT");
    return "UPDATED";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
