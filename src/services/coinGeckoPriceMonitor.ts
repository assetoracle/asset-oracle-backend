import { createHash } from "node:crypto";
import { database } from "../config/database.js";

export const COINGECKO_TARGETS = {
  bitcoin: { symbol: "BTC", thresholdUsd: 100_000 },
  ethereum: { symbol: "ETH", thresholdUsd: 4_000 },
  binancecoin: { symbol: "BNB", thresholdUsd: 1_000 },
} as const;

export type CoinGeckoAssetId = keyof typeof COINGECKO_TARGETS;

const POLL_INTERVAL_MS = 60_000;
const MAX_SOURCE_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

type CoinGeckoAssetPayload = {
  usd?: number;
  usd_market_cap?: number;
  last_updated_at?: number;
};

export type CoinGeckoObservation = {
  assetId: CoinGeckoAssetId;
  symbol: string;
  priceUsd: number;
  marketCapUsd: number | null;
  sourceUpdatedAt: string;
  checkedAt: string;
  evidenceHash: string;
  evidence: Record<string, unknown>;
};

export function parseCoinGeckoObservation(
  assetId: CoinGeckoAssetId,
  payload: CoinGeckoAssetPayload,
  checkedAt = new Date(),
): Omit<CoinGeckoObservation, "evidenceHash" | "evidence"> {
  const target = COINGECKO_TARGETS[assetId];
  const price = payload.usd;
  const updatedAt = payload.last_updated_at;
  const marketCap = payload.usd_market_cap;

  if (!Number.isFinite(price) || Number(price) <= 0 || !Number.isFinite(updatedAt)) {
    throw new Error(`CoinGecko response is missing a valid ${target.symbol} price or source timestamp`);
  }

  const sourceTimeMs = Number(updatedAt) * 1000;
  if (checkedAt.getTime() - sourceTimeMs > MAX_SOURCE_AGE_MS) {
    throw new Error(`CoinGecko ${target.symbol} source timestamp is stale`);
  }
  if (sourceTimeMs - checkedAt.getTime() > MAX_FUTURE_SKEW_MS) {
    throw new Error(`CoinGecko ${target.symbol} source timestamp is in the future`);
  }
  if (marketCap !== undefined && (!Number.isFinite(marketCap) || marketCap < 0)) {
    throw new Error(`CoinGecko returned an invalid ${target.symbol} market capitalization`);
  }

  return {
    assetId,
    symbol: target.symbol,
    priceUsd: Number(price),
    marketCapUsd: marketCap === undefined ? null : Number(marketCap),
    sourceUpdatedAt: new Date(sourceTimeMs).toISOString(),
    checkedAt: checkedAt.toISOString(),
  };
}

export async function collectCoinGeckoObservations(
  checkedAt = new Date(),
): Promise<CoinGeckoObservation[]> {
  const ids = Object.keys(COINGECKO_TARGETS).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`CoinGecko returned HTTP ${response.status}`);

  const raw = await response.json() as Record<string, CoinGeckoAssetPayload>;
  return (Object.keys(COINGECKO_TARGETS) as CoinGeckoAssetId[]).map((assetId) => {
    const parsed = parseCoinGeckoObservation(assetId, raw[assetId] ?? {}, checkedAt);
    const evidence = {
      provider: "CoinGecko",
      assetId,
      symbol: parsed.symbol,
      priceUsd: parsed.priceUsd,
      marketCapUsd: parsed.marketCapUsd,
      sourceUpdatedAt: parsed.sourceUpdatedAt,
      checkedAt: parsed.checkedAt,
      raw: raw[assetId],
    };
    const evidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    return { ...parsed, evidenceHash, evidence };
  });
}

export async function initializeCoinGeckoObservationStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS coingecko_price_observations (
      id BIGSERIAL PRIMARY KEY,
      asset_id TEXT NOT NULL CHECK (asset_id IN ('bitcoin', 'ethereum', 'binancecoin')),
      symbol TEXT NOT NULL,
      price_usd NUMERIC NOT NULL,
      market_cap_usd NUMERIC,
      source_updated_at TIMESTAMPTZ NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      evidence JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`CREATE INDEX IF NOT EXISTS coingecko_price_asset_checked_idx ON coingecko_price_observations (asset_id, checked_at DESC)`);
}

export async function saveCoinGeckoObservations(observations: CoinGeckoObservation[]): Promise<void> {
  for (const item of observations) {
    await database.query(
      `INSERT INTO coingecko_price_observations
        (asset_id, symbol, price_usd, market_cap_usd, source_updated_at, checked_at, evidence_hash, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (evidence_hash) DO NOTHING`,
      [
        item.assetId,
        item.symbol,
        item.priceUsd,
        item.marketCapUsd,
        item.sourceUpdatedAt,
        item.checkedAt,
        item.evidenceHash,
        JSON.stringify(item.evidence),
      ],
    );
  }
}

let monitorStarted = false;
let monitorBusy = false;

export async function startCoinGeckoPriceMonitor(): Promise<void> {
  if (monitorStarted) return;
  monitorStarted = true;
  try {
    await initializeCoinGeckoObservationStore();
  } catch (error) {
    monitorStarted = false;
    throw error;
  }

  const runOnce = async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      const observations = await collectCoinGeckoObservations();
      await saveCoinGeckoObservations(observations);
      console.info("CoinGecko threshold observations saved", {
        assets: observations.length,
        checkedAt: observations[0]?.checkedAt,
      });
    } catch (error) {
      console.error(
        "CoinGecko monitor could not record a complete observation batch:",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      monitorBusy = false;
    }
  };

  await runOnce();
  setInterval(() => void runOnce(), POLL_INTERVAL_MS).unref();
}
