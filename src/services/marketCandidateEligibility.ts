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
  if (typeof proposal === "object" && proposal !== null && "closesAt" in proposal) {
    const closesAt = (proposal as { closesAt?: unknown }).closesAt;
    if (typeof closesAt === "string") {
      const closingTime = Date.parse(closesAt);
      if (Number.isFinite(closingTime) && closingTime <= now) {
        return { valid: false, reason: "This candidate has expired. Dismiss it and generate a fresh candidate before promotion." };
      }
    }
  }

  const parsed = marketProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { valid: false, reason: `This candidate is no longer valid: ${parsed.error.issues[0].message}` };
  }
  const normalizedCategory = candidateCategory === "Crypto" ? "Digital Assets" : candidateCategory;
  if (parsed.data.category !== normalizedCategory) {
    return { valid: false, reason: "Candidate category does not match its proposal. Manual review is required." };
  }
  return { valid: true, proposal: parsed.data };
}
