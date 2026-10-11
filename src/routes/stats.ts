import { Router } from "express";
import { database } from "../config/database.js";

const statsRouter = Router();

/**
 * Only reports metrics supported by verified data sources.
 * Published proposal counts are database-backed. Wallet totals and trading
 * volume/settlement metrics remain null until an on-chain event indexer and
 * verified market-manager deployment are configured.
 */
statsRouter.get("/dashboard", async (_req, res, next) => {
  try {
    const markets = await database.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM market_proposals WHERE status = 'APPROVED'",
    );

    return res.status(200).json({
      totalUsers: null,
      tradingVolume24h: null,
      totalMarkets: Number(markets.rows[0]?.total ?? 0),
      totalSettled: null,
      totalTradingVolume: null,
      dataStatus: {
        totalUsers: "UNAVAILABLE",
        tradingVolume24h: "AWAITING_VERIFIED_ONCHAIN_INDEX",
        totalMarkets: "APPROVED_DATABASE_MARKETS",
        totalSettled: "AWAITING_VERIFIED_ONCHAIN_INDEX",
        totalTradingVolume: "AWAITING_VERIFIED_ONCHAIN_INDEX",
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default statsRouter;
