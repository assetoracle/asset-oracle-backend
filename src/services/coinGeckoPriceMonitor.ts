import { createHash } from "node:crypto";
import { database } from "../config/database.js";
import { COINGECKO_TARGETS, parseCoinGeckoObservation, type CoinGeckoAssetId } from "./coinGeckoPricing.js";

const POLL_INTERVAL_MS = 60_000;

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

  const raw = await response.json() as Record<string, { usd?: number; usd_market_cap?: number; last_updated_at?: number }>;
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
