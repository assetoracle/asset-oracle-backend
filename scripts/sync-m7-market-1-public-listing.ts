import "dotenv/config";
import pg from "pg";
import { createPublicClient, http, parseAbi, parseEventLogs } from "viem";

const CHAIN_ID = 42421;
const RPC_URL = process.env.ASSET_CHAIN_RPC_URL || "https://enugu-rpc.assetchain.org";
const MANAGER = "0xa3c11C6141689050c83f2b53f7e5892BF2fffeD2" as const;
const TX_HASH = "0x94ef8cb55fb9060dde4bc7551d8b5b6ff6772f54abf08ac71d26a5a41d24971d" as const;
const MARKET_ID = 1n;
const QUESTION = "Will BTC/USD be above $76,000 at the observation deadline?";
const USDC = "0xc33741fddEBeA854d265db6F9707900Efb0211a2".toLowerCase();

const abi = parseAbi([
  "event MarketCreated(uint256 indexed marketId,address indexed creator,uint8 stablecoin,uint64 closeTime,string question)",
  "function getMarket(uint256 marketId) view returns ((uint256 id,address creator,uint8 marketType,uint8 stablecoin,string question,string resolutionRules,string evidenceSource,uint64 closeTime,uint64 challengePeriod,uint64 resolvedAt,uint256 totalYes,uint256 totalNo,uint256 totalStaked,uint8 outcome,uint8 status,bytes32 evidenceHash) market)",
  "function stablecoins(uint8 kind) view returns (address token,uint8 decimals,bool enabled)"
]);

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  const client = createPublicClient({ transport: http(RPC_URL), chain: {
    id: CHAIN_ID, name: "Asset Chain Enugu", nativeCurrency: { name: "RWA", symbol: "RWA", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } }
  }});

  const chain = await client.getChainId();
  if (chain !== CHAIN_ID) throw new Error(`Wrong chain ID: ${chain}`);

  const receipt = await client.getTransactionReceipt({ hash: TX_HASH });
  if (receipt.status !== "success") throw new Error("Publication transaction did not succeed.");
  if (receipt.to?.toLowerCase() !== MANAGER.toLowerCase()) throw new Error("Publication transaction target does not match the configured manager.");

  const events = parseEventLogs({ abi, logs: receipt.logs, eventName: "MarketCreated", strict: false });
  const created = events.find((event) => event.args.marketId === MARKET_ID);
  if (!created) throw new Error("The verified transaction does not contain MarketCreated for market 1.");

  const market = await client.readContract({ address: MANAGER, abi, functionName: "getMarket", args: [MARKET_ID] });
  const token = await client.readContract({ address: MANAGER, abi, functionName: "stablecoins", args: [0] });
  if (market.id !== MARKET_ID || market.question !== QUESTION || market.stablecoin !== 0 || market.challengePeriod !== 3600n) {
    throw new Error("On-chain market fields do not match the approved M7 BTC market details.");
  }
  if (token.token.toLowerCase() !== USDC || token.decimals !== 6 || !token.enabled) {
    throw new Error("On-chain USDC configuration does not match the approved testnet token.");
  }

  const closesAt = new Date(Number(market.closeTime) * 1000).toISOString();
  const resolvesAt = new Date((Number(market.closeTime) + Number(market.challengePeriod)) * 1000).toISOString();
  const resolutionRule = {
    sourceId: "coingecko",
    metric: "BTC/USD",
    comparison: "ABOVE",
    targetValue: 76000,
    currency: "USD",
    observationTime: closesAt,
    description: "At the market observation deadline, use CoinGecko's Bitcoin USD price. YES only if the observed price is strictly above 76000 USD; otherwise NO. Preserve the source response and observation timestamp as evidence.",
    query: { coinId: "bitcoin", vsCurrency: "usd" }
  };

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 20000 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const existing = await db.query(
      "SELECT id, onchain_market_id, onchain_tx_hash FROM market_proposals WHERE onchain_chain_id=$1 AND lower(onchain_manager_address)=lower($2) AND onchain_market_id=$3 FOR UPDATE",
      [CHAIN_ID, MANAGER, MARKET_ID.toString()]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.onchain_tx_hash?.toLowerCase() !== TX_HASH.toLowerCase()) throw new Error("Market 1 already has a different transaction recorded. No database change made.");
      await db.query("COMMIT");
      console.log("SYNC ALREADY COMPLETE");
      console.log("Market ID:", MARKET_ID.toString());
      console.log("Existing public database record:", row.id);
      return;
    }

    const duplicateTx = await db.query("SELECT id FROM market_proposals WHERE lower(onchain_tx_hash)=lower($1)", [TX_HASH]);
    if (duplicateTx.rows.length) throw new Error("This transaction hash is already attached to a different database record.");

    const inserted = await db.query(
      `INSERT INTO market_proposals
       (id, "walletAddress", question, description, category, "closesAt", "resolvesAt", "resolutionRule",
        status, "submittedAt", origin, visibility, onchain_market_id, onchain_tx_hash, onchain_manager_address, onchain_chain_id)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'Digital Assets', $3, $4, $5::jsonb,
        'APPROVED', NOW(), 'MANUAL', 'PUBLIC', $6, $7, lower($8), $9)
       RETURNING id`,
      [QUESTION, "A testnet BTC/USD threshold market resolved using the CoinGecko Bitcoin USD price at the on-chain observation deadline.", closesAt, resolvesAt, JSON.stringify(resolutionRule), MARKET_ID.toString(), TX_HASH.toLowerCase(), MANAGER, CHAIN_ID]
    );
    await db.query("COMMIT");
    console.log("PUBLIC MARKET DATABASE SYNC VERIFIED");
    console.log("Market ID:", MARKET_ID.toString());
    console.log("Database record:", inserted.rows[0].id);
    console.log("Transaction:", TX_HASH);
    console.log("Close time UTC:", closesAt);
    console.log("Resolution time UTC:", resolvesAt);
    console.log("Visibility: PUBLIC");
    console.log("No blockchain transaction was submitted.");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("MARKET DATABASE SYNC FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
