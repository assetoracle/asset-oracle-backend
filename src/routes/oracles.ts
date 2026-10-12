import { Router } from "express";
import { database } from "../config/database.js";

const oraclesRouter = Router();
const SHALOM_THRESHOLD_USD = 1;
const MAX_FRESH_SECONDS = 180;

oraclesRouter.get("/shalom/latest", async (_req, res) => {
  try {
    const result = await database.query<{
      id: string;
      shalom_price_usdt: string;
      usdt_usd_price: string;
      shalom_price_usd: string;
      observed_at: Date | string;
      evidence_hash: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT id, shalom_price_usdt, usdt_usd_price, shalom_price_usd,
              observed_at, evidence_hash, evidence
       FROM shalom_dex_observations
       ORDER BY observed_at DESC
       LIMIT 100`,
    );
    const observations = result.rows.map((row) => ({
      id: row.id,
      shalomPriceUsdt: Number(row.shalom_price_usdt),
      usdtUsdPrice: Number(row.usdt_usd_price),
      shalomPriceUsd: Number(row.shalom_price_usd),
      observedAt: new Date(row.observed_at).toISOString(),
      evidenceHash: row.evidence_hash,
      evidence: row.evidence,
    }));
    const latest = observations[0] ?? null;
    const ageSeconds = latest ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.observedAt)) / 1000)) : null;
    const sourceFresh = ageSeconds !== null && ageSeconds <= MAX_FRESH_SECONDS;
    return res.status(200).json({
      source: "Asset Chain Swap 5-minute TWAP via SHALOM/xRWA and xRWA/USDT pools",
      thresholdUsd: SHALOM_THRESHOLD_USD,
      status: !latest ? "NO_OBSERVATIONS" : sourceFresh ? "FRESH" : "STALE",
      sourceFresh,
      latestObservationAgeSeconds: ageSeconds,
      thresholdObservedInLatest100: observations.some((item) => item.shalomPriceUsd >= SHALOM_THRESHOLD_USD),
      latest,
      observations,
      settlementWarning: "Monitoring evidence only. This does not settle markets or establish complete coverage of the full market window.",
    });
  } catch (error) {
    return res.status(503).json({
      error: "SHALOM DEX evidence is unavailable. The monitor may not be configured or initialized.",
      details: error instanceof Error ? error.message : "Unknown database error",
    });
  }
});

export default oraclesRouter;
