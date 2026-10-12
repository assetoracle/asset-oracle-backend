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
      details: "No observation table or recent evidence is available yet.",
    });
  }
});


oraclesRouter.get("/shalom/window", async (req, res) => {
  const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to : new Date().toISOString();
  const fromMs = Date.parse(fromRaw);
  const toMs = Date.parse(toRaw);

  if (!fromRaw || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return res.status(400).json({
      error: "Provide valid ISO timestamps: ?from=<window-start>&to=<window-end>.",
    });
  }

  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  try {
    const result = await database.query<{
      observation_count: number;
      first_observed_at: Date | string | null;
      last_observed_at: Date | string | null;
      threshold_observed: boolean | null;
      max_gap_seconds: number | string | null;
    }>(
      `WITH windowed AS (
         SELECT observed_at, shalom_price_usd,
                LAG(observed_at) OVER (ORDER BY observed_at) AS previous_observed_at
         FROM shalom_dex_observations
         WHERE observed_at >= $1::timestamptz AND observed_at <= $2::timestamptz
       )
       SELECT COUNT(*)::int AS observation_count,
              MIN(observed_at) AS first_observed_at,
              MAX(observed_at) AS last_observed_at,
              COALESCE(BOOL_OR(shalom_price_usd >= 1), FALSE) AS threshold_observed,
              MAX(EXTRACT(EPOCH FROM observed_at - previous_observed_at)) AS max_gap_seconds
       FROM windowed`,
      [from, to],
    );

    const row = result.rows[0];
    const count = Number(row?.observation_count ?? 0);
    const first = row?.first_observed_at ? new Date(row.first_observed_at).toISOString() : null;
    const last = row?.last_observed_at ? new Date(row.last_observed_at).toISOString() : null;
    const maxGapSeconds = row?.max_gap_seconds === null || row?.max_gap_seconds === undefined
      ? null
      : Number(row.max_gap_seconds);
    const firstWithinWindow = first !== null && Date.parse(first) - fromMs <= 180_000;
    const lastWithinWindow = last !== null && toMs - Date.parse(last) <= 180_000;
    const gapsWithinLimit = maxGapSeconds !== null && maxGapSeconds <= 180;
    const coverageLooksContinuous = count > 0 && firstWithinWindow && lastWithinWindow && gapsWithinLimit;

    return res.status(200).json({
      source: "Asset Chain Swap 5-minute TWAP via SHALOM/xRWA and xRWA/USDT pools",
      thresholdUsd: SHALOM_THRESHOLD_USD,
      window: { from, to },
      observationCount: count,
      firstObservedAt: first,
      lastObservedAt: last,
      maxGapSeconds,
      thresholdObserved: Boolean(row?.threshold_observed),
      coverageLooksContinuous,
      coverageRules: {
        maxInitialDelaySeconds: 180,
        maxFinalDelaySeconds: 180,
        maxGapSeconds: 180,
      },
      settlementWarning: "This summary is evidence for human review only. It does not automatically settle a market or prove that the source is economically manipulation-resistant.",
    });
  } catch {
    return res.status(503).json({
      error: "SHALOM DEX window evidence is unavailable. The monitor may not be configured or initialized.",
    });
  }
});

export default oraclesRouter;
