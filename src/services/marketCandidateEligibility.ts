import { marketProposalSchema, type MarketProposalInput } from "./marketValidation.js";

export type CandidatePromotionValidation =
  | { valid: true; proposal: MarketProposalInput }
  | { valid: false; reason: string };

/** Revalidate at decision time; generation-time validity does not guarantee a live closing window. */
export function validateCandidateForPromotion(
  proposal: unknown,
  candidateCategory: string,
  now = Date.now(),
): CandidatePromotionValidation {
  const parsed = marketProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const expired = issue.path[0] === "closesAt" &&
      typeof proposal === "object" && proposal !== null &&
      "closesAt" in proposal &&
      typeof (proposal as { closesAt?: unknown }).closesAt === "string" &&
      Date.parse((proposal as { closesAt: string }).closesAt) <= now;
    return {
      valid: false,
      reason: expired
        ? "This candidate has expired. Dismiss it and generate a fresh candidate before promotion."
        : `This candidate is no longer valid: ${issue.message}`,
    };
  }
  const normalizedCategory = candidateCategory === "Crypto" ? "Digital Assets" : candidateCategory;
  if (parsed.data.category !== normalizedCategory) {
    return { valid: false, reason: "Candidate category does not match its proposal. Manual review is required." };
  }
  return { valid: true, proposal: parsed.data };
}
