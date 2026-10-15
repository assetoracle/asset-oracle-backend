import { Router } from "express";
import { createPublicClient, formatUnits, http, isAddress } from "viem";
import { formatIndexedAmount, normalizeManagerAddresses, getWalletIndexerStatus } from "./walletHistory.js";

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

const WALLET_ACCOUNT_ABI = [
  { type: "function", name: "marketCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ name: "market", type: "tuple", components: [
    { name: "id", type: "uint256" }, { name: "creator", type: "address" }, { name: "stablecoin", type: "uint8" },
    { name: "question", type: "string" }, { name: "resolutionRules", type: "string" }, { name: "evidenceSource", type: "string" },
    { name: "closeTime", type: "uint64" }, { name: "challengePeriod", type: "uint64" }, { name: "resolvedAt", type: "uint64" },
    { name: "totalYes", type: "uint256" }, { name: "totalNo", type: "uint256" }, { name: "totalStaked", type: "uint256" },
    { name: "outcome", type: "uint8" }, { name: "status", type: "uint8" }, { name: "evidenceHash", type: "bytes32" }
  ] }] },
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }], outputs: [{ name: "yes", type: "uint256" }, { name: "no", type: "uint256" }, { name: "claimed", type: "bool" }] },
  { type: "function", name: "stablecoins", stateMutability: "view", inputs: [{ name: "", type: "uint8" }], outputs: [{ name: "token", type: "address" }, { name: "decimals", type: "uint8" }, { name: "enabled", type: "bool" }] }
] as const;

statsRouter.get("/wallet/:address", async (req, res) => {
  const address = req.params.address;
  if (!isAddress(address)) return res.status(400).json({ error: "A valid wallet address is required." });
  const manager = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const configuredChainId = Number(process.env.ASSET_CHAIN_ID || EXPECTED_CHAIN_ID);
  if (!manager || !isAddress(manager) || configuredChainId !== EXPECTED_CHAIN_ID) {
    return res.status(503).json({ error: "Verified Asset Oracle market manager is not configured." });
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
    if (await client.getChainId() !== EXPECTED_CHAIN_ID) return res.status(503).json({ error: "Configured RPC is not Asset Chain Enugu testnet." });
    const code = await client.getCode({ address: manager });
    if (!code || code === "0x") return res.status(503).json({ error: "Verified market manager contract was not found." });
    const count = Number(await client.readContract({ address: manager, abi: WALLET_ACCOUNT_ABI, functionName: "marketCount" }));
    if (!Number.isSafeInteger(count) || count < 0 || count > 5000) return res.status(503).json({ error: "Market count is outside the supported account-history range." });

    const positions: Array<Record<string, unknown>> = [];
    const claimable: Array<Record<string, unknown>> = [];
    const marketDecimals = new Map<number, number>();
    const wallet = address.toLowerCase();
    for (let start = 1; start <= count; start += 10) {
      const ids = Array.from({ length: Math.min(10, count - start + 1) }, (_, index) => start + index);
      const batch = await Promise.all(ids.map(async (id) => {
        const [marketRaw, positionRaw] = await Promise.all([
          client.readContract({ address: manager, abi: WALLET_ACCOUNT_ABI, functionName: "getMarket", args: [BigInt(id)] }),
          client.readContract({ address: manager, abi: WALLET_ACCOUNT_ABI, functionName: "positions", args: [BigInt(id), address] }),
        ]);
        const market = marketRaw as unknown as readonly unknown[] & {
          id?: bigint; stablecoin?: number; question?: string; totalYes?: bigint; totalNo?: bigint;
          totalStaked?: bigint; outcome?: number; status?: number; resolvedAt?: bigint;
        };
        const stablecoinId = Number(market.stablecoin ?? market[2]);
        const question = String(market.question ?? market[3] ?? "");
        const totalYes = BigInt(market.totalYes ?? market[9] as bigint);
        const totalNo = BigInt(market.totalNo ?? market[10] as bigint);
        const totalStake = BigInt(market.totalStaked ?? market[11] as bigint);
        const outcome = Number(market.outcome ?? market[12]);
        const status = Number(market.status ?? market[13]);
        const resolvedAt = BigInt(market.resolvedAt ?? market[8] as bigint);
        const position = positionRaw as unknown as readonly [bigint, bigint, boolean];
        const yes = position[0];
        const no = position[1];
        const claimed = position[2];
        if (yes === 0n && no === 0n) return null;
        const coin = await client.readContract({ address: manager, abi: WALLET_ACCOUNT_ABI, functionName: "stablecoins", args: [stablecoinId] });
        const decimals = Number((coin as unknown as readonly [string, number, boolean])[1]);
        marketDecimals.set(id, decimals);
        const winningPool = outcome === 1 ? totalYes : outcome === 2 ? totalNo : 0n;
        let payout = 0n;
        if ((status === 3 || status === 4 || status === 5) && !claimed) {
          if (status === 4 || status === 5 || outcome === 3) payout = yes + no;
          else if (winningPool === 0n) payout = ((yes + no) * 7500n) / 10000n;
          else {
            const winningStake = outcome === 1 ? yes : no;
            if (winningStake > 0n) {
              const settlementFee = (totalStake * 200n) / 10000n;
              payout = (winningStake * (totalStake - settlementFee)) / winningPool;
            }
          }
        }
        const row = {
          marketId: id, question, yesStake: formatUnits(yes, decimals),
          noStake: formatUnits(no, decimals), status, outcome,
          claimed, timestamp: resolvedAt ? new Date(Number(resolvedAt) * 1000).toISOString() : null,
          tokenDecimals: decimals, claimableAmount: formatUnits(payout, decimals),
        };
        positions.push(row);
        if ((status === 3 || status === 4 || status === 5) && !claimed) claimable.push(row);
        return row;
      }));
      void batch;
    }

    let history: Array<Record<string, unknown>> = [];
    let historyStatus = "INDEXER_DISABLED";
    if (process.env.ONCHAIN_STATS_INDEXER_ENABLED === "true") {
      try {
        const legacyManagers = (process.env.ASSET_ORACLE_LEGACY_MARKET_MANAGER_ADDRESSES || "").split(",");
        const indexedManagers = normalizeManagerAddresses(manager, legacyManagers);
        const database = (await import("../config/database.js")).database;
        const result = await database.query<{
          manager_address: string; event_name: string; tx_hash: string; block_number: string; block_timestamp: Date;
          market_id: string; gross_amount: string | null; outcome: number | null;
        }>(`SELECT manager_address, event_name, tx_hash, block_number::text, block_timestamp, market_id::text, gross_amount::text, outcome
            FROM onchain_stats_events
            WHERE chain_id = $1 AND manager_address = ANY($2::text[]) AND wallet_address = $3
            ORDER BY block_number DESC, log_index DESC LIMIT 250`, [EXPECTED_CHAIN_ID, indexedManagers, wallet]);
        const historyDecimals = new Map<string, number>();
        const resolveHistoryDecimals = async (managerAddress: string, marketId: string): Promise<number | null> => {
          const key = `${managerAddress.toLowerCase()}:${marketId}`;
          const cached = historyDecimals.get(key);
          if (cached !== undefined) return cached;
          try {
            const marketRaw = await client.readContract({
              address: managerAddress as `0x${string}`,
              abi: WALLET_ACCOUNT_ABI,
              functionName: "getMarket",
              args: [BigInt(marketId)],
            });
            const market = marketRaw as unknown as readonly unknown[] & { stablecoin?: number };
            const stablecoinId = Number(market.stablecoin ?? market[2]);
            if (!Number.isInteger(stablecoinId) || stablecoinId < 0 || stablecoinId > 255) return null;
            const coin = await client.readContract({
              address: managerAddress as `0x${string}`,
              abi: WALLET_ACCOUNT_ABI,
              functionName: "stablecoins",
              args: [stablecoinId],
            });
            const decimals = Number((coin as unknown as readonly [string, number, boolean])[1]);
            if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
            historyDecimals.set(key, decimals);
            return decimals;
          } catch {
            return null;
          }
        };
        history = await Promise.all(result.rows.map(async (row) => {
          const decimals = row.gross_amount === null ? null : await resolveHistoryDecimals(row.manager_address, row.market_id);
          return {
            type: row.event_name, transactionHash: row.tx_hash, blockNumber: row.block_number,
            timestamp: new Date(row.block_timestamp).toISOString(), marketId: row.market_id,
            amount: formatIndexedAmount(row.gross_amount, decimals),
            outcome: row.outcome,
          };
        }));
        const cursorResult = await database.query<{
          manager_address: string; last_scanned_block: string; updated_at: Date;
        }>("SELECT manager_address, last_scanned_block::text, updated_at FROM onchain_stats_cursors WHERE chain_id = $1 AND manager_address = ANY($2::text[])", [EXPECTED_CHAIN_ID, indexedManagers]);
        const headBlock = await client.getBlockNumber();
        historyStatus = getWalletIndexerStatus(indexedManagers, cursorResult.rows, headBlock, Date.now());
      } catch {
        historyStatus = "INDEX_UNAVAILABLE";
      }
    }
    return res.json({ address: wallet, chainId: EXPECTED_CHAIN_ID, positions, claimable, history, historyStatus });
  } catch {
    return res.status(503).json({ error: "Wallet history could not be retrieved from the verified chain RPC." });
  }
});

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
