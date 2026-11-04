import { keccak256, stringToHex } from "viem";
import { database } from "../config/database.js";

export async function getPaidProposalEscrowContext(proposalId: string): Promise<{
  submissionId: string;
  status: string;
  proposalIdHash: string;
} | null> {
  const result = await database.query<{
    id: string;
    status: string;
  }>(
    "SELECT id, status FROM paid_market_submissions WHERE proposal_id = $1",
    [proposalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    submissionId: row.id,
    status: row.status,
    proposalIdHash: keccak256(stringToHex(proposalId)),
  };
}
