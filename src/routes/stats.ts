import { Router } from "express";
import { createPublicClient, http, isAddress } from "viem";

const statsRouter = Router();
const DEFAULT_RPC_URL = "https://enugu-rpc.assetchain.org";
const EXPECTED_CHAIN_ID = 42421;
const MARKET_MANAGER_ABI = [{
  type: "function",
  name: "marketCount",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

/** Return only verified chain metrics; no synthetic dashboard numbers. */
statsRouter.get("/dashboard", async (_req, res) => {
  let totalMarkets: number | null = null;
  let totalMarketsStatus = "AWAITING_VERIFIED_ONCHAIN_MARKET_MANAGER";
  let totalUsers: number | null = null;
  let tradingVolume24h: string | null = null;
  let totalSettled: number | null = null;
  let totalTradingVolume: string | null = null;
  let indexerStatus = "AWAITING_VERIFIED_ONCHAIN_INDEX";
  let lastIndexedBlock: string | null = null;

  const managerAddress = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const configuredChainId = Number(process.env.ASSET_CHAIN_ID || EXPECTED_CHAIN_ID);

  if (managerAddress && isAddress(managerAddress) && configuredChainId === EXPECTED_CHAIN_ID) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
      const actualChainId = await client.getChainId();
      if (actualChainId === EXPECTED_CHAIN_ID) {
        const code = await client.getCode({ address: managerAddress });
        if (code && code !== "0x") {
          const count = await client.readContract({
            address: managerAddress,
            abi: MARKET_MANAGER_ABI,
            functionName: "marketCount",
          });
          const safeCount = Number(count);
          if (Number.isSafeInteger(safeCount) && safeCount >= 0) {
            totalMarkets = safeCount;
            totalMarketsStatus = "VERIFIED_ONCHAIN_MARKET_MANAGER";
          } else totalMarketsStatus = "ONCHAIN_MARKET_COUNT_OUT_OF_RANGE";
        } else totalMarketsStatus = "MARKET_MANAGER_CODE_NOT_FOUND";
      } else totalMarketsStatus = "RPC_CHAIN_ID_MISMATCH";
    } catch {
      totalMarketsStatus = "ONCHAIN_MARKET_COUNT_UNAVAILABLE";
    }

    if (process.env.ONCHAIN_STATS_INDEXER_ENABLED === "true") {
      try {
        const { readOnchainDashboardMetrics } = await import("../services/onchainStatsIndexer.js");
        const metrics = await readOnchainDashboardMetrics(managerAddress);
        indexerStatus = metrics.indexerStatus;
        lastIndexedBlock = metrics.lastIndexedBlock;
        if (indexerStatus === "VERIFIED_ONCHAIN_EVENT_INDEX") {
          totalUsers = metrics.totalUsers;
          tradingVolume24h = metrics.tradingVolume24h;
          totalSettled = metrics.totalSettled;
          totalTradingVolume = metrics.totalTradingVolume;
        }
      } catch {
        indexerStatus = "ONCHAIN_EVENT_INDEX_UNAVAILABLE";
      }
    } else indexerStatus = "INDEXER_DISABLED";
  } else if (managerAddress && !isAddress(managerAddress)) {
    totalMarketsStatus = "INVALID_MARKET_MANAGER_ADDRESS";
  } else if (configuredChainId !== EXPECTED_CHAIN_ID) {
    totalMarketsStatus = "RPC_CHAIN_ID_CONFIGURATION_MISMATCH";
  }

  return res.status(200).json({
    totalUsers,
    tradingVolume24h,
    totalMarkets,
    totalSettled,
    totalTradingVolume,
    lastIndexedBlock,
    dataStatus: {
      totalUsers: indexerStatus,
      tradingVolume24h: indexerStatus,
      totalMarkets: totalMarketsStatus,
      totalSettled: indexerStatus,
      totalTradingVolume: indexerStatus,
    },
  });
});

export default statsRouter;
