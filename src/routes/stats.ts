import { Router } from "express";

const statsRouter = Router();

/**
 * Only returns verified metrics. Approved proposals are off-chain submissions,
 * not deployed/on-chain markets, so they must never be presented as market count.
 * Trading volume and settlement counts stay null until a verified manager and
 * an indexed on-chain data source are configured.
 */
statsRouter.get("/dashboard", async (_req, res) => {
  return res.status(200).json({
    totalUsers: null,
    tradingVolume24h: null,
    totalMarkets: null,
    totalSettled: null,
    totalTradingVolume: null,
    dataStatus: {
      totalUsers: "AWAITING_VERIFIED_WALLET_ACTIVITY_INDEX",
      tradingVolume24h: "AWAITING_VERIFIED_ONCHAIN_INDEX",
      totalMarkets: "AWAITING_VERIFIED_ONCHAIN_MARKET_MANAGER",
      totalSettled: "AWAITING_VERIFIED_ONCHAIN_INDEX",
      totalTradingVolume: "AWAITING_VERIFIED_ONCHAIN_INDEX",
    },
  });
});

export default statsRouter;
