export function buildMarketScanIds(totalMarkets: number, startId: number, limit: number): number[] {
  if (!Number.isSafeInteger(totalMarkets) || totalMarkets <= 0) return [];
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const normalizedStart = Number.isSafeInteger(startId) && startId >= 1
    ? ((startId - 1) % totalMarkets) + 1
    : 1;
  const count = Math.min(totalMarkets, limit);
  return Array.from({ length: count }, (_, offset) => ((normalizedStart - 1 + offset) % totalMarkets) + 1);
}

export function orderMarketIdsFromCursor(marketIds: number[], cursorId: number, totalMarkets: number): number[] {
  if (marketIds.length === 0 || totalMarkets <= 0) return [];
  const normalizedCursor = Number.isSafeInteger(cursorId) && cursorId >= 1
    ? ((cursorId - 1) % totalMarkets) + 1
    : 1;
  return [...marketIds].sort((a, b) => {
    const distanceA = (a - normalizedCursor + totalMarkets) % totalMarkets;
    const distanceB = (b - normalizedCursor + totalMarkets) % totalMarkets;
    return distanceA - distanceB;
  });
}

export function nextMarketCursor(processedId: number, totalMarkets: number): number {
  if (!Number.isSafeInteger(totalMarkets) || totalMarkets <= 0) return 1;
  return processedId >= totalMarkets ? 1 : processedId + 1;
}
