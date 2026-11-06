/**
 * Pure lifecycle eligibility rules shared by the worker and unit tests.
 * Status values match AssetOracleMarketManager:
 * 0 OPEN, 1 CLOSED, 2 DISPUTED, 3 SETTLED, 6 ARBITRATION.
 */
export function isMarketClosable(status: number, closeTime: bigint, now: bigint): boolean {
  return status === 0 && closeTime <= now;
}

export function isUnresolvedRefundDue(
  status: number,
  closeTime: bigint,
  challengePeriod: bigint,
  now: bigint,
): boolean {
  return status === 1 && closeTime + challengePeriod <= now;
}

export function isMarketFinalizable(
  status: number,
  resolvedAt: bigint,
  challengePeriod: bigint,
  now: bigint,
): boolean {
  return status === 2 && resolvedAt + challengePeriod <= now;
}

export function isDisputeRefundDue(
  status: number,
  resolvedAt: bigint,
  disputeResolutionTimeout: bigint,
  now: bigint,
): boolean {
  return status === 6 && resolvedAt + disputeResolutionTimeout <= now;
}

export function canProcessPayoutBatch(
  status: number,
  batchesProcessed: number,
  maxBatchesPerRun: number,
): boolean {
  return status === 3 && batchesProcessed < maxBatchesPerRun;
}

/** A stale or out-of-range persisted cursor safely restarts at index zero. */
export function normalizePayoutStartIndex(participantCount: number, persistedNextIndex: number): number {
  if (!Number.isFinite(participantCount) || participantCount <= 0) return 0;
  if (!Number.isInteger(persistedNextIndex) || persistedNextIndex < 0 || persistedNextIndex >= participantCount) return 0;
  return persistedNextIndex;
}

export function getPayoutBatchSize(
  participantCount: number,
  startIndex: number,
  maxBatchSize: number,
): number {
  if (!Number.isFinite(participantCount) || !Number.isFinite(startIndex) || !Number.isFinite(maxBatchSize)) return 0;
  if (participantCount <= 0 || startIndex < 0 || startIndex >= participantCount || maxBatchSize <= 0) return 0;
  return Math.min(Math.floor(maxBatchSize), participantCount - Math.floor(startIndex));
}
