import { formatUnits, isAddress } from "viem";
export type WalletIndexerCursor = { manager_address: string; last_scanned_block: string; updated_at: Date | string; };
export function normalizeManagerAddresses(current: string, legacy: string[]): string[] {
  const configured = [current, ...legacy].map((value) => value.trim()).filter((value) => isAddress(value));
  return [...new Set(configured.map((value) => value.toLowerCase()))];
}
export function formatIndexedAmount(raw: string | null, decimals: number | null): string | null {
  if (raw === null || decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  return formatUnits(BigInt(raw), decimals);
}
export function getWalletIndexerStatus(managers: string[], cursors: WalletIndexerCursor[], headBlock: bigint, nowMs = Date.now()): string {
  const byManager = new Map(cursors.map((cursor) => [cursor.manager_address.toLowerCase(), cursor]));
  if (managers.some((manager) => !byManager.has(manager.toLowerCase()))) return "INDEXER_NOT_INITIALIZED";
  for (const manager of managers) {
    const cursor = byManager.get(manager.toLowerCase())!;
    const indexedBlock = BigInt(cursor.last_scanned_block);
    const updatedAt = new Date(cursor.updated_at).getTime();
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt > 120_000 || indexedBlock > headBlock || headBlock - indexedBlock > 3n) return "INDEXER_CATCHING_UP";
  }
  return "VERIFIED_ONCHAIN_EVENT_INDEX";
}
