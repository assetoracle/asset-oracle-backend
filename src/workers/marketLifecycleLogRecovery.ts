export async function findLogInBlockRanges<T>(
  latestBlock: bigint,
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
  matches: (entry: T) => boolean,
  chunkSize = 2_000n,
): Promise<T | undefined> {
  if (latestBlock < 0n) return undefined;
  if (chunkSize <= 0n) throw new Error("Log recovery chunk size must be positive.");

  for (let fromBlock = 0n; fromBlock <= latestBlock; fromBlock += chunkSize) {
    const toBlock = fromBlock + chunkSize - 1n < latestBlock
      ? fromBlock + chunkSize - 1n
      : latestBlock;
    let entries: readonly T[];
    try {
      entries = await fetchRange(fromBlock, toBlock);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown RPC error";
      throw new Error(`Unable to recover publication logs in block range ${fromBlock}-${toBlock}: ${detail}`);
    }
    const match = entries.find(matches);
    if (match) return match;
  }

  return undefined;
}
