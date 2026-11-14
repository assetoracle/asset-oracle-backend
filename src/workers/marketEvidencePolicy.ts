/** Select approved manual and automated proposals whose resolution time is still ahead. */
export function selectEvidenceEligibleProposals<T extends {
  status: string;
  resolvesAt: string | Date;
}>(proposals: T[], now = Date.now()): T[] {
  return proposals
    .filter((proposal) => proposal.status === "APPROVED" && Date.parse(String(proposal.resolvesAt)) > now)
    .sort((a, b) => Date.parse(String(a.resolvesAt)) - Date.parse(String(b.resolvesAt)));
}
