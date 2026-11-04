import { keccak256, stringToHex } from "viem";
import { database } from "../config/database.js";

export async function getPaidProposalEscrowContext(proposalId: string): Promise<{
  submissionId: string;
  status: string;
  payer: string;
  proposalIdHash: string;
} | null> {
  const result = await database.query<{
    id: string;
    status: string;
    wallet_address: string;
  }>(
    "SELECT id, status, wallet_address FROM paid_market_submissions WHERE proposal_id = $1",
    [proposalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    submissionId: row.id,
    status: row.status,
    payer: row.wallet_address,
    proposalIdHash: keccak256(stringToHex(proposalId)),
  };
}
