import { Router } from "express";
import { createPublicClient, http, isAddress } from "viem";

const statsRouter = Router();

const DEFAULT_RPC_URL = "https://enugu-rpc.assetchain.org";
const EXPECTED_CHAIN_ID = 42421;
const MARKET_MANAGER_ABI = [
  {
    type: "function",
    name: "marketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Only return verified metrics. Proposal records are off-chain submissions,
 * not deployed/on-chain markets. The manager's marketCount is read directly
 * from the configured Enugu contract; metrics requiring transaction indexing
 * remain null until a verified index is available.
 */
statsRouter.get("/dashboard", async (_req, res) => {
  let totalMarkets: number | null = null;
  let totalMarketsStatus = "AWAITING_VERIFIED_ONCHAIN_MARKET_MANAGER";

  const managerAddress = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const configuredChainId = Number(process.env.ASSET_CHAIN_ID || EXPECTED_CHAIN_ID);

  if (managerAddress && isAddress(managerAddress) && configuredChainId === EXPECTED_CHAIN_ID) {
    try {
      const client = createPublicClient({
        transport: http(rpcUrl, { timeout: 10_000 }),
      });
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
          } else {
            totalMarketsStatus = "ONCHAIN_MARKET_COUNT_OUT_OF_RANGE";
          }
        } else {
          totalMarketsStatus = "MARKET_MANAGER_CODE_NOT_FOUND";
        }
      } else {
        totalMarketsStatus = "RPC_CHAIN_ID_MISMATCH";
      }
    } catch {
      totalMarketsStatus = "ONCHAIN_MARKET_COUNT_UNAVAILABLE";
    }
  } else if (managerAddress && !isAddress(managerAddress)) {
    totalMarketsStatus = "INVALID_MARKET_MANAGER_ADDRESS";
  } else if (configuredChainId !== EXPECTED_CHAIN_ID) {
    totalMarketsStatus = "RPC_CHAIN_ID_CONFIGURATION_MISMATCH";
  }

  return res.status(200).json({
    totalUsers: null,
    tradingVolume24h: null,
    totalMarkets,
    totalSettled: null,
    totalTradingVolume: null,
    dataStatus: {
      totalUsers: "AWAITING_VERIFIED_WALLET_ACTIVITY_INDEX",
      tradingVolume24h: "AWAITING_VERIFIED_ONCHAIN_INDEX",
      totalMarkets: totalMarketsStatus,
      totalSettled: "AWAITING_VERIFIED_ONCHAIN_INDEX",
      totalTradingVolume: "AWAITING_VERIFIED_ONCHAIN_INDEX",
    },
  });
});

export default statsRouter;
