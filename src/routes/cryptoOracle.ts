import { Router } from "express";
import { database } from "../config/database.js";
import { COINGECKO_TARGETS, type CoinGeckoAssetId } from "../services/coinGeckoPricing.js";

const router = Router();
const MAX_FRESH_SECONDS = 180;
const allowedAssets = Object.keys(COINGECKO_TARGETS) as CoinGeckoAssetId[];

router.get("/crypto/latest", async (_req, res) => {
  try {
    const result = await database.query<{
      asset_id: CoinGeckoAssetId;
      symbol: string;
      price_usd: string;
      market_cap_usd: string | null;
      source_updated_at: Date | string;
      checked_at: Date | string;
      evidence_hash: string;
    }>(
      `SELECT DISTINCT ON (asset_id)
         asset_id, symbol, price_usd, market_cap_usd,
         source_updated_at, checked_at, evidence_hash
       FROM coingecko_price_observations
       ORDER BY asset_id, checked_at DESC`,
    );

    const observations = result.rows.map((row) => {
      const checkedAt = new Date(row.checked_at).toISOString();
      const sourceUpdatedAt = new Date(row.source_updated_at).toISOString();
      const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(sourceUpdatedAt)) / 1000));
      return {
        assetId: row.asset_id,
        symbol: row.symbol,
        thresholdUsd: COINGECKO_TARGETS[row.asset_id].thresholdUsd,
        priceUsd: Number(row.price_usd),
        marketCapUsd: row.market_cap_usd === null ? null : Number(row.market_cap_usd),
        sourceUpdatedAt,
        checkedAt,
        sourceFresh: ageSeconds <= MAX_FRESH_SECONDS,
        sourceAgeSeconds: ageSeconds,
        thresholdObserved: Number(row.price_usd) >= COINGECKO_TARGETS[row.asset_id].thresholdUsd,
        evidenceHash: row.evidence_hash,
      };
    });

    return res.status(200).json({
      source: "CoinGecko simple price API",
      observations,
      settlementWarning: "These are sampled provider observations, not proof of every instantaneous price movement. Missing/stale data must not be interpreted as NO.",
    });
  } catch {
    return res.status(503).json({
      error: "CoinGecko price evidence is unavailable. The monitor may not be configured or initialized.",
    });
  }
});

router.get("/crypto/window", async (req, res) => {
  const assetRaw = typeof req.query.asset === "string" ? req.query.asset : "";
  const assetId = allowedAssets.includes(assetRaw as CoinGeckoAssetId)
    ? assetRaw as CoinGeckoAssetId
    : null;
  const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to : new Date().toISOString();
  const fromMs = Date.parse(fromRaw);
  const toMs = Date.parse(toRaw);

  if (!assetId || !fromRaw || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return res.status(400).json({
      error: "Provide asset=bitcoin|ethereum|binancecoin and valid ISO timestamps: ?from=<window-start>&to=<window-end>.",
    });
  }

  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const threshold = COINGECKO_TARGETS[assetId].thresholdUsd;

  try {
    const result = await database.query<{
      observation_count: number;
      first_observed_at: Date | string | null;
      last_observed_at: Date | string | null;
      threshold_observed: boolean | null;
      max_gap_seconds: number | string | null;
    }>(
      `WITH windowed AS (
         SELECT checked_at, price_usd,
                LAG(checked_at) OVER (ORDER BY checked_at) AS previous_checked_at
         FROM coingecko_price_observations
         WHERE asset_id = $1
           AND checked_at >= $2::timestamptz
           AND checked_at <= $3::timestamptz
       )
       SELECT COUNT(*)::int AS observation_count,
              MIN(checked_at) AS first_observed_at,
              MAX(checked_at) AS last_observed_at,
              COALESCE(BOOL_OR(price_usd >= $4), FALSE) AS threshold_observed,
              MAX(EXTRACT(EPOCH FROM checked_at - previous_checked_at)) AS max_gap_seconds
       FROM windowed`,
      [assetId, from, to, threshold],
    );

    const row = result.rows[0];
    const count = Number(row?.observation_count ?? 0);
    const first = row?.first_observed_at ? new Date(row.first_observed_at).toISOString() : null;
    const last = row?.last_observed_at ? new Date(row.last_observed_at).toISOString() : null;
    const maxGapSeconds = row?.max_gap_seconds === null || row?.max_gap_seconds === undefined
      ? null
      : Number(row.max_gap_seconds);
    const coverageLooksContinuous = count > 0 &&
      first !== null && Date.parse(first) - fromMs <= MAX_FRESH_SECONDS * 1000 &&
      last !== null && toMs - Date.parse(last) <= MAX_FRESH_SECONDS * 1000 &&
      maxGapSeconds !== null && maxGapSeconds <= MAX_FRESH_SECONDS;

    return res.status(200).json({
      source: "CoinGecko simple price API",
      assetId,
      symbol: COINGECKO_TARGETS[assetId].symbol,
      thresholdUsd: threshold,
      window: { from, to },
      observationCount: count,
      firstObservedAt: first,
      lastObservedAt: last,
      maxGapSeconds,
      thresholdObserved: Boolean(row?.threshold_observed),
      coverageLooksContinuous,
      coverageRules: {
        maxInitialDelaySeconds: MAX_FRESH_SECONDS,
        maxFinalDelaySeconds: MAX_FRESH_SECONDS,
        maxGapSeconds: MAX_FRESH_SECONDS,
      },
      settlementWarning: "Sampled evidence only. Human review is required; this endpoint does not automatically settle a market or prove every instantaneous price movement.",
    });
  } catch {
    return res.status(503).json({
      error: "CoinGecko window evidence is unavailable. The monitor may not be configured or initialized.",
    });
  }
});

export default router;
