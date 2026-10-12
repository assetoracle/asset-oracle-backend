import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import { database } from "../config/database.js";

const EXPECTED_CHAIN_ID = 42421;
const DEFAULT_START_BLOCK = 4_502_688n;
const DEFAULT_BATCH_SIZE = 1_000n;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const CONFIRMATION_DEPTH = 3n;

const stakedEvent = parseAbiItem(
  "event Staked(uint256 indexed marketId, address indexed user, bool yesSide, uint256 grossAmount, uint256 fee, uint256 netAmount)",
);
const finalizedEvent = parseAbiItem(
  "event MarketFinalized(uint256 indexed marketId, uint8 outcome)",
);

type IndexedEvent = {
  chainId: number;
  txHash: string;
  logIndex: number;
  eventName: "Staked" | "MarketFinalized";
  blockNumber: bigint;
  blockTimestamp: Date;
  marketId: string;
  walletAddress: string | null;
  grossAmount: string | null;
  outcome: number | null;
};

function safeIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function toHexHash(log: Log): string {
  if (!log.transactionHash || log.logIndex === null || log.blockNumber === null) {
    throw new Error("Indexer received a log without canonical transaction/block coordinates.");
  }
  return log.transactionHash.toLowerCase();
}

function decimalAmount(raw: string): string {
  const value = BigInt(raw);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export { decimalAmount };

export async function initializeOnchainStatsIndexer(): Promise<void> {
  const managerAddress = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  const configuredChainId = Number(process.env.ASSET_CHAIN_ID || EXPECTED_CHAIN_ID);
  if (!managerAddress || !/^0x[0-9a-fA-F]{40}$/.test(managerAddress)) {
    throw new Error("On-chain stats indexer requires a valid market manager address.");
  }
  if (configuredChainId !== EXPECTED_CHAIN_ID) {
    throw new Error("On-chain stats indexer only supports Asset Chain Enugu testnet (42421).");
  }

  await database.query(`
    CREATE TABLE IF NOT EXISTS onchain_stats_events (
      chain_id INTEGER NOT NULL,
      manager_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      event_name TEXT NOT NULL CHECK (event_name IN ('Staked', 'MarketFinalized')),
      block_number BIGINT NOT NULL,
      block_timestamp TIMESTAMPTZ NOT NULL,
      market_id NUMERIC(78, 0) NOT NULL,
      wallet_address TEXT,
      gross_amount NUMERIC(78, 0),
      outcome SMALLINT,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS onchain_stats_events_timestamp_idx
    ON onchain_stats_events (chain_id, manager_address, block_timestamp)
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS onchain_stats_events_wallet_idx
    ON onchain_stats_events (chain_id, manager_address, wallet_address)
    WHERE wallet_address IS NOT NULL
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS onchain_stats_cursors (
      chain_id INTEGER NOT NULL,
      manager_address TEXT NOT NULL,
      last_scanned_block BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, manager_address)
    )
  `);

  const startBlock = BigInt(process.env.ASSET_ORACLE_INDEXER_START_BLOCK || DEFAULT_START_BLOCK.toString());
  if (startBlock < 0n) throw new Error("Indexer start block must not be negative.");
  await database.query(
    `INSERT INTO onchain_stats_cursors (chain_id, manager_address, last_scanned_block)
     VALUES ($1, $2, $3)
     ON CONFLICT (chain_id, manager_address) DO NOTHING`,
    [EXPECTED_CHAIN_ID, managerAddress.toLowerCase(), (startBlock - 1n).toString()],
  );

  const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || "https://enugu-rpc.assetchain.org";
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  const actualChainId = await client.getChainId();
  if (actualChainId !== EXPECTED_CHAIN_ID) {
    throw new Error("Indexer RPC chain ID does not match Asset Chain Enugu testnet.");
  }
  const code = await client.getCode({ address: managerAddress as `0x${string}` });
  if (!code || code === "0x") throw new Error("Indexer manager address has no contract bytecode.");

  let busy = false;
  const pollOnce = async () => {
    if (busy) return;
    busy = true;
    try {
      const cursorResult = await database.query<{ last_scanned_block: string }>(
        `SELECT last_scanned_block FROM onchain_stats_cursors
         WHERE chain_id = $1 AND manager_address = $2`,
        [EXPECTED_CHAIN_ID, managerAddress.toLowerCase()],
      );
      if (!cursorResult.rows[0]) throw new Error("Indexer cursor is missing.");
      const lastScanned = BigInt(cursorResult.rows[0].last_scanned_block);
      const head = await client.getBlockNumber();
      if (head <= CONFIRMATION_DEPTH || lastScanned >= head - CONFIRMATION_DEPTH) {
        await database.query(
          `UPDATE onchain_stats_cursors SET updated_at = NOW()
           WHERE chain_id = $1 AND manager_address = $2`,
          [EXPECTED_CHAIN_ID, managerAddress.toLowerCase()],
        );
        return;
      }
      const batchSize = BigInt(safeIntegerEnv("ASSET_ORACLE_INDEXER_BATCH_SIZE", Number(DEFAULT_BATCH_SIZE), 100, 2_000));
      const fromBlock = lastScanned + 1n;
      const toBlock = fromBlock + batchSize - 1n < head - CONFIRMATION_DEPTH
        ? fromBlock + batchSize - 1n
        : head - CONFIRMATION_DEPTH;

      const [stakeLogs, finalizedLogs] = await Promise.all([
        client.getLogs({ address: managerAddress as `0x${string}`, event: stakedEvent, fromBlock, toBlock }),
        client.getLogs({ address: managerAddress as `0x${string}`, event: finalizedEvent, fromBlock, toBlock }),
      ]);
      const logs = [
        ...stakeLogs.map((log) => ({ log, eventName: "Staked" as const })),
        ...finalizedLogs.map((log) => ({ log, eventName: "MarketFinalized" as const })),
      ].sort((a, b) => Number(a.log.blockNumber! - b.log.blockNumber!) ||
        Number(a.log.logIndex! - b.log.logIndex!));

      const timestamps = new Map<string, Date>();
      for (const { log } of logs) {
        const blockNumber = log.blockNumber!;
        const key = blockNumber.toString();
        if (!timestamps.has(key)) {
          const block = await client.getBlock({ blockNumber });
          timestamps.set(key, new Date(Number(block.timestamp) * 1000));
        }
      }

      const rows: IndexedEvent[] = logs.map(({ log, eventName }) => {
        const hash = toHexHash(log);
        const decoded = log as typeof log & { args: Record<string, unknown> };
        const args = decoded.args;
        if (eventName === "Staked") {
          return {
            chainId: EXPECTED_CHAIN_ID,
            txHash: hash,
            logIndex: log.logIndex!,
            eventName,
            blockNumber: log.blockNumber!,
            blockTimestamp: timestamps.get(log.blockNumber!.toString())!,
            marketId: String(args.marketId),
            walletAddress: String(args.user).toLowerCase(),
            grossAmount: String(args.grossAmount),
            outcome: null,
          };
        }
        return {
          chainId: EXPECTED_CHAIN_ID,
          txHash: hash,
          logIndex: log.logIndex!,
          eventName,
          blockNumber: log.blockNumber!,
          blockTimestamp: timestamps.get(log.blockNumber!.toString())!,
          marketId: String(args.marketId),
          walletAddress: null,
          grossAmount: null,
          outcome: Number(args.outcome),
        };
      });

      const dbClient = await database.connect();
      try {
        await dbClient.query("BEGIN");
        for (const row of rows) {
          await dbClient.query(
            `INSERT INTO onchain_stats_events
             (chain_id, manager_address, tx_hash, log_index, event_name, block_number,
              block_timestamp, market_id, wallet_address, gross_amount, outcome)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
            [
              row.chainId, managerAddress.toLowerCase(), row.txHash, row.logIndex,
              row.eventName, row.blockNumber.toString(), row.blockTimestamp,
              row.marketId, row.walletAddress, row.grossAmount, row.outcome,
            ],
          );
        }
        await dbClient.query(
          `UPDATE onchain_stats_cursors SET last_scanned_block = $3, updated_at = NOW()
           WHERE chain_id = $1 AND manager_address = $2 AND last_scanned_block = $4`,
          [EXPECTED_CHAIN_ID, managerAddress.toLowerCase(), toBlock.toString(), lastScanned.toString()],
        );
        await dbClient.query("COMMIT");
      } catch (error) {
        await dbClient.query("ROLLBACK");
        throw error;
      } finally {
        dbClient.release();
      }
    } catch (error) {
      console.error("On-chain stats indexer batch failed:", error instanceof Error ? error.message : "Unknown error");
    } finally {
      busy = false;
    }
  };

  const intervalMs = safeIntegerEnv("ASSET_ORACLE_INDEXER_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS, 5_000, 300_000);
  void pollOnce();
  const timer = setInterval(() => void pollOnce(), intervalMs);
  timer.unref();
  console.log("Persistent Enugu on-chain stats indexer enabled.");
}

export async function readOnchainDashboardMetrics(managerAddress: string): Promise<{
  totalUsers: number | null;
  tradingVolume24h: string | null;
  totalSettled: number | null;
  totalTradingVolume: string | null;
  lastIndexedBlock: string | null;
  indexerStatus: string;
}> {
  const manager = managerAddress.toLowerCase();
  const cursor = await database.query<{ last_scanned_block: string; updated_at: Date }>(
    `SELECT last_scanned_block, updated_at FROM onchain_stats_cursors
     WHERE chain_id = $1 AND manager_address = $2`,
    [EXPECTED_CHAIN_ID, manager],
  );
  if (!cursor.rows[0]) {
    return { totalUsers: null, tradingVolume24h: null, totalSettled: null, totalTradingVolume: null, lastIndexedBlock: null, indexerStatus: "INDEXER_NOT_INITIALIZED" };
  }
  const lastIndexedBlock = cursor.rows[0].last_scanned_block;
  const isStale = Date.now() - new Date(cursor.rows[0].updated_at).getTime() > 120_000;
  const aggregate = await database.query<{
    total_users: string;
    trading_volume_24h: string;
    total_settled: string;
    total_trading_volume: string;
  }>(
    `SELECT
       COUNT(DISTINCT wallet_address)::text AS total_users,
       COALESCE(SUM(gross_amount) FILTER (WHERE event_name = 'Staked' AND block_timestamp >= NOW() - INTERVAL '24 hours'), 0)::text AS trading_volume_24h,
       COUNT(*) FILTER (WHERE event_name = 'MarketFinalized')::text AS total_settled,
       COALESCE(SUM(gross_amount) FILTER (WHERE event_name = 'Staked'), 0)::text AS total_trading_volume
     FROM onchain_stats_events
     WHERE chain_id = $1 AND manager_address = $2`,
    [EXPECTED_CHAIN_ID, manager],
  );
  const row = aggregate.rows[0];
  return {
    totalUsers: Number(row.total_users),
    tradingVolume24h: decimalAmount(row.trading_volume_24h),
    totalSettled: Number(row.total_settled),
    totalTradingVolume: decimalAmount(row.total_trading_volume),
    lastIndexedBlock,
    indexerStatus: isStale ? "INDEXER_STALE" : "VERIFIED_ONCHAIN_EVENT_INDEX",
  };
}
