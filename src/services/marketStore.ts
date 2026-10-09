import { randomUUID } from "node:crypto";
import type { MarketProposalInput } from "./marketValidation.js";

export type StoredMarketProposal = MarketProposalInput & {
  id: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  submittedAt: string;
};

const proposals = new Map<string, StoredMarketProposal>();

export function createMarketProposal(
  input: MarketProposalInput,
): StoredMarketProposal {
  const proposal: StoredMarketProposal = {
    ...input,
    id: randomUUID(),
    status: "PENDING_APPROVAL",
    submittedAt: new Date().toISOString(),
  };

  proposals.set(proposal.id, proposal);

  return proposal;
}

export function listMarketProposals(): StoredMarketProposal[] {
  return Array.from(proposals.values());
}

export function getMarketProposal(
  id: string,
): StoredMarketProposal | undefined {
  return proposals.get(id);
}