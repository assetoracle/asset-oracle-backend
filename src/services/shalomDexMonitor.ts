import { createHash } from "node:crypto";
import { database } from "../config/database.js";
import { meanTickFromCumulatives, priceAtTick } from "./shalomDexPricing.js";
import {
  createPublicClient,
  http,
  isAddress,
  type Address,
} from "viem";

const MAINNET_CHAIN_ID = 42420;
const DEFAULT_RPC_URL = "https://mainnet-rpc.assetchain.org";
const DEFAULT_FACTORY = "0xa9d53862d01190e78ddaf924a8f497b4f8bb5163";
const TWAP_WINDOW_SECONDS = 300;
const POLL_INTERVAL_MS = 60_000;

const factoryAbi = [{
  type: "function",
  name: "getPool",
  stateMutability: "view",
  inputs: [
    { name: "tokenA", type: "address" },
    { name: "tokenB", type: "address" },
    { name: "fee", type: "uint24" },
  ],
  outputs: [{ name: "pool", type: "address" }],
}] as const;

const poolAbi = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

type DexMonitorConfig = {
  rpcUrl: string;
  factory: Address;
  shalom: Address;
  xrwa: Address;
  usdt: Address;
  shalomXrwaFee: number;
  xrwaUsdtFee: number;
  shalomXrwaMinLiquidity: bigint;
  xrwaUsdtMinLiquidity: bigint;
};

function positiveNumber(_name: string, raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positiveBigInt(name: string, raw: string | undefined): bigint | null {
  if (!raw?.trim() || !/^\d+$/.test(raw.trim())) return null;
  const value = BigInt(raw.trim());
  return value > 0n ? value : null;
}

function addressEnv(name: string, fallback?: string): Address | null {
  const raw = process.env[name]?.trim() || fallback;
  return raw && isAddress(raw) ? raw as Address : null;
}

function loadConfig(): DexMonitorConfig | null {
  const factory = addressEnv("SHALOM_DEX_FACTORY_ADDRESS", DEFAULT_FACTORY);
  const shalom = addressEnv("SHALOM_TOKEN_ADDRESS");
  const xrwa = addressEnv("ASSET_CHAIN_XRWA_TOKEN_ADDRESS");
  const usdt = addressEnv("ASSET_CHAIN_USDT_TOKEN_ADDRESS");
  const shalomXrwaFee = positiveNumber("SHALOM_XRWA_POOL_FEE", process.env.SHALOM_XRWA_POOL_FEE || "10000");
  const xrwaUsdtFee = positiveNumber("XRWA_USDT_POOL_FEE", process.env.XRWA_USDT_POOL_FEE || "3000");
  const shalomXrwaMinLiquidity = positiveBigInt(
    "SHALOM_XRWA_MIN_LIQUIDITY",
    process.env.SHALOM_XRWA_MIN_LIQUIDITY,
  );
  const xrwaUsdtMinLiquidity = positiveBigInt(
    "XRWA_USDT_MIN_LIQUIDITY",
    process.env.XRWA_USDT_MIN_LIQUIDITY,
  );

  if (
    !factory || !shalom || !xrwa || !usdt ||
    shalomXrwaFee === null || xrwaUsdtFee === null ||
    !Number.isInteger(shalomXrwaFee) || !Number.isInteger(xrwaUsdtFee) ||
    shalomXrwaFee > 1_000_000 || xrwaUsdtFee > 1_000_000 ||
    !shalomXrwaMinLiquidity || !xrwaUsdtMinLiquidity
  ) return null;

  return {
    rpcUrl: process.env.ASSET_CHAIN_MAINNET_RPC_URL?.trim() || DEFAULT_RPC_URL,
    factory,
    shalom,
    xrwa,
    usdt,
    shalomXrwaFee,
    xrwaUsdtFee,
    shalomXrwaMinLiquidity,
    xrwaUsdtMinLiquidity,
  };
}

function priceOfBaseInQuote(
  tick: number,
  token0: Address,
  token1: Address,
  base: Address,
  quote: Address,
  decimals0: number,
  decimals1: number,
): number {
  const token0PerToken1 = priceAtTick(tick, decimals0, decimals1);
  if (token0.toLowerCase() === base.toLowerCase() && token1.toLowerCase() === quote.toLowerCase()) {
    return token0PerToken1;
  }
  if (token1.toLowerCase() === base.toLowerCase() && token0.toLowerCase() === quote.toLowerCase()) {
    return 1 / token0PerToken1;
  }
  throw new Error("Pool token identities do not match the configured route");
}

async function getTwapPoolPrice(
  client: ReturnType<typeof createPublicClient>,
  config: DexMonitorConfig,
  blockNumber: bigint,
  tokenA: Address,
  tokenB: Address,
  fee: number,
  minimumLiquidity: bigint,
  base: Address,
  quote: Address,
): Promise<{ pool: Address; tick: number; price: number; liquidity: string }> {
  const pool = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [tokenA, tokenB, fee],
    blockNumber,
  }) as Address;

  if (!isAddress(pool) || pool.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No DEX pool exists for the configured token pair and fee ${fee}`);
  }
  const code = await client.getCode({ address: pool, blockNumber });
  if (!code || code === "0x") throw new Error("Configured pool has no deployed contract code");

  const [token0, token1, liquidity, cumulative] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "token0", blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "token1", blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "liquidity", blockNumber }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "observe",
      args: [[TWAP_WINDOW_SECONDS, 0]],
      blockNumber,
    }),
  ]);

  if (BigInt(liquidity) < minimumLiquidity) {
    throw new Error("Pool liquidity is below the configured minimum");
  }

  const expected = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  const actual = [String(token0).toLowerCase(), String(token1).toLowerCase()].sort();
  if (expected[0] !== actual[0] || expected[1] !== actual[1]) {
    throw new Error("Resolved pool tokens do not match the configured pair");
  }

  const token0Address = token0 as Address;
  const token1Address = token1 as Address;
  const [decimals0, decimals1] = await Promise.all([
    client.readContract({ address: token0Address, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address: token1Address, abi: erc20Abi, functionName: "decimals", blockNumber }),
  ]);

  const cumulatives = cumulative[0] as readonly bigint[];
  if (cumulatives.length !== 2) throw new Error("DEX did not return both TWAP cumulative observations");
  const tick = meanTickFromCumulatives(cumulatives[0], cumulatives[1], TWAP_WINDOW_SECONDS);
  const price = priceOfBaseInQuote(
    tick,
    token0Address,
    token1Address,
    base,
    quote,
    Number(decimals0),
    Number(decimals1),
  );

  return { pool, tick, price, liquidity: String(liquidity) };
}

export type ShalomDexObservation = {
  chainId: number;
  tokenAddress: string;
  xrwaAddress: string;
  usdtAddress: string;
  shalomXrwaPool: string;
  xrwaUsdtPool: string;
  shalomXrwaTwapTick: number;
  xrwaUsdtTwapTick: number;
  shalomPriceUsdt: number;
  usdtUsdPrice: number;
  usdtUsdObservedAt: string;
  shalomPriceUsd: number;
  observedAt: string;
  blockNumber: string;
  evidenceHash: string;
};

async function fetchUsdtUsdPrice(): Promise<{ price: number; observedAt: string; raw: unknown }> {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true",
    { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error("USDT/USD reference returned HTTP " + response.status);
  const raw = await response.json() as { tether?: { usd?: number; last_updated_at?: number } };
  const price = raw.tether?.usd;
  const updatedAt = raw.tether?.last_updated_at;
  if (!Number.isFinite(price) || Number(price) <= 0 || !Number.isFinite(updatedAt)) {
    throw new Error("USDT/USD reference response is missing a valid price or timestamp");
  }
  const observedAt = new Date(Number(updatedAt) * 1000).toISOString();
  if (Date.now() - Number(updatedAt) * 1000 > 5 * 60 * 1000) throw new Error("USDT/USD reference data is stale");
  if (Number(updatedAt) * 1000 > Date.now() + 60_000) throw new Error("USDT/USD reference timestamp is in the future");
  return { price: Number(price), observedAt, raw };
}

export async function collectShalomDexObservation(): Promise<ShalomDexObservation> {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      "SHALOM DEX monitor is not configured. Set verified xRWA/USDT token addresses and minimum liquidity values.",
    );
  }

  const client = createPublicClient({
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
  const chainId = await client.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) throw new Error(`Wrong RPC chain ID: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);

  const blockNumber = await client.getBlockNumber();
  const [shalomSymbol, xrwaSymbol, usdtSymbol] = await Promise.all([
    client.readContract({ address: config.shalom, abi: erc20Abi, functionName: "symbol", blockNumber }),
    client.readContract({ address: config.xrwa, abi: erc20Abi, functionName: "symbol", blockNumber }),
    client.readContract({ address: config.usdt, abi: erc20Abi, functionName: "symbol", blockNumber }),
  ]);
  if (String(shalomSymbol).toUpperCase() !== "SHALOM") throw new Error("Configured SHALOM contract symbol did not match SHALOM");
  if (String(xrwaSymbol).toUpperCase() !== "XRWA") throw new Error("Configured xRWA contract symbol did not match xRWA");
  if (String(usdtSymbol).toUpperCase() !== "USDT") throw new Error("Configured bridged USDT contract symbol did not match USDT");

  const [shalomXrwa, xrwaUsdt, usdtUsd] = await Promise.all([
    getTwapPoolPrice(
      client, config, blockNumber, config.shalom, config.xrwa, config.shalomXrwaFee,
      config.shalomXrwaMinLiquidity, config.shalom, config.xrwa,
    ),
    getTwapPoolPrice(
      client, config, blockNumber, config.xrwa, config.usdt, config.xrwaUsdtFee,
      config.xrwaUsdtMinLiquidity, config.xrwa, config.usdt,
    ),
    fetchUsdtUsdPrice(),
  ]);

  const shalomPriceUsdt = shalomXrwa.price * xrwaUsdt.price;
  const shalomPriceUsd = shalomPriceUsdt * usdtUsd.price;
  if (!Number.isFinite(shalomPriceUsd) || shalomPriceUsd <= 0) throw new Error("Calculated SHALOM USD price is invalid");

  const block = await client.getBlock({ blockNumber });
  const observedAt = new Date(Number(block.timestamp) * 1000).toISOString();
  const evidence = {
    chainId,
    tokenAddress: config.shalom,
    xrwaAddress: config.xrwa,
    usdtAddress: config.usdt,
    shalomXrwaPool: shalomXrwa.pool,
    xrwaUsdtPool: xrwaUsdt.pool,
    shalomXrwaTwapTick: shalomXrwa.tick,
    xrwaUsdtTwapTick: xrwaUsdt.tick,
    shalomPriceUsdt,
    usdtUsdPrice: usdtUsd.price,
    usdtUsdObservedAt: usdtUsd.observedAt,
    shalomPriceUsd,
    observedAt,
    blockNumber: String(blockNumber),
    shalomXrwaLiquidity: shalomXrwa.liquidity,
    xrwaUsdtLiquidity: xrwaUsdt.liquidity,
    usdtUsdReference: usdtUsd.raw,
  };
  const evidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

  return { ...evidence, evidenceHash };
}

export async function initializeShalomDexMonitorStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS shalom_dex_observations (
      id BIGSERIAL PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      shalom_xrwa_pool TEXT NOT NULL,
      xrwa_usdt_pool TEXT NOT NULL,
      shalom_price_usdt NUMERIC NOT NULL,
      usdt_usd_price NUMERIC NOT NULL,
      shalom_price_usd NUMERIC NOT NULL,
      shalom_xrwa_twap_tick INTEGER NOT NULL,
      xrwa_usdt_twap_tick INTEGER NOT NULL,
      block_number NUMERIC NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      evidence JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function saveShalomDexObservation(observation: ShalomDexObservation): Promise<void> {
  await database.query(
    `INSERT INTO shalom_dex_observations
      (chain_id, token_address, shalom_xrwa_pool, xrwa_usdt_pool,
       shalom_price_usdt, usdt_usd_price, shalom_price_usd,
       shalom_xrwa_twap_tick, xrwa_usdt_twap_tick, block_number,
       observed_at, evidence_hash, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (evidence_hash) DO NOTHING`,
    [
      observation.chainId,
      observation.tokenAddress.toLowerCase(),
      observation.shalomXrwaPool.toLowerCase(),
      observation.xrwaUsdtPool.toLowerCase(),
      observation.shalomPriceUsdt,
      observation.usdtUsdPrice,
      observation.shalomPriceUsd,
      observation.shalomXrwaTwapTick,
      observation.xrwaUsdtTwapTick,
      observation.blockNumber,
      observation.observedAt,
      observation.evidenceHash,
      JSON.stringify(observation),
    ],
  );
}

let monitorStarted = false;
let monitorBusy = false;

export async function startShalomDexMonitor(): Promise<void> {
  if (monitorStarted) return;
  monitorStarted = true;
  try {
    await initializeShalomDexMonitorStore();
  } catch (error) {
    monitorStarted = false;
    throw error;
  }

  const runOnce = async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      const observation = await collectShalomDexObservation();
      await saveShalomDexObservation(observation);
      console.info("SHALOM DEX TWAP observation saved", {
        priceUsd: observation.shalomPriceUsd,
        blockNumber: observation.blockNumber,
        evidenceHash: observation.evidenceHash,
      });
    } catch (error) {
      console.error(
        "SHALOM DEX monitor could not record an observation:",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      monitorBusy = false;
    }
  };

  await runOnce();
  setInterval(() => void runOnce(), POLL_INTERVAL_MS).unref();
}
