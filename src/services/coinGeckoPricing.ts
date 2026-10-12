export const COINGECKO_TARGETS = {
  bitcoin: { symbol: "BTC", thresholdUsd: 100_000 },
  ethereum: { symbol: "ETH", thresholdUsd: 4_000 },
  binancecoin: { symbol: "BNB", thresholdUsd: 1_000 },
} as const;

export type CoinGeckoAssetId = keyof typeof COINGECKO_TARGETS;

type CoinGeckoAssetPayload = {
  usd?: number;
  usd_market_cap?: number;
  last_updated_at?: number;
};

export type ParsedCoinGeckoObservation = {
  assetId: CoinGeckoAssetId;
  symbol: string;
  priceUsd: number;
  marketCapUsd: number | null;
  sourceUpdatedAt: string;
  checkedAt: string;
};

const MAX_SOURCE_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

export function parseCoinGeckoObservation(
  assetId: CoinGeckoAssetId,
  payload: CoinGeckoAssetPayload,
  checkedAt = new Date(),
): ParsedCoinGeckoObservation {
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
