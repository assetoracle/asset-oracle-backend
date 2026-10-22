import { keccak256, toBytes } from "viem";

/**
 * A validator's on-chain evidence hash must commit to the exact normalized source URL
 * stored by the API. The same trim rule is applied before hashing and persistence.
 */
export function evidenceHashMatchesSourceUrl(evidenceHash: string, sourceUrl: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(evidenceHash)) return false;
  const expected = keccak256(toBytes(sourceUrl.trim()));
  return evidenceHash.toLowerCase() === expected.toLowerCase();
}
