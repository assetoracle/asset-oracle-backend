/**
 * Referral qualification must be backed by a stake confirmed strictly after
 * the referral attribution. Block timestamps have one-second precision, so a
 * same-second transaction is conservatively treated as unprovable.
 */
export function isStakeAfterReferralAttribution(
  blockTimestamp: bigint,
  attributedAt: Date | string,
): boolean {
  const attributionDate = attributedAt instanceof Date ? attributedAt : new Date(attributedAt);
  if (!Number.isFinite(attributionDate.getTime())) return false;
  return blockTimestamp * 1000n > BigInt(attributionDate.getTime());
}
