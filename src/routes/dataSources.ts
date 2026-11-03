import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { isAdminWallet } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";
import {
  dexscreenerSearch, dexscreenerTokenPairs, coinGeckoCoin,
  defiLlamaProtocols, defiLlamaProtocolTvl, defiLlamaHistoricalChainTvl,
  sportmonksFixtures, apiFootballFixtures,
  fredObservations, worldBankIndicator,
  gdeltArticles, openMeteoForecast,
} from "../services/dataProviders.js";

const dataSourcesRouter = Router();
const authSchema = z.object({ address: z.string().refine(isAddress, "Invalid wallet address") });

async function authorize(req: import("express").Request, res: import("express").Response, address: string): Promise<boolean> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!await verifyWalletSession(token, address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address)) {
    res.status(403).json({ error: "Only the configured admin wallet can query provider data through this endpoint." });
    return false;
  }
  return true;
}
function providerError(res: import("express").Response, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  return res.status(502).json({ error: "Data provider request failed.", detail: message });
}
async function runProvider(req: import("express").Request, res: import("express").Response, address: string, task: () => Promise<unknown>) {
  if (!await authorize(req, res, address)) return;
  try { return res.json(await task()); } catch (error) { return providerError(res, error); }
}

// DIGITAL ASSETS
dataSourcesRouter.post("/dexscreener/search", async (req, res) => {
  const p = authSchema.extend({ query: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and search query are required." });
  return runProvider(req, res, p.data.address, () => dexscreenerSearch(p.data.query));
});
dataSourcesRouter.post("/dexscreener/token-pairs", async (req, res) => {
  const p = authSchema.extend({ chain: z.string().min(1).max(40), tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address, chain, and token contract address are required." });
  return runProvider(req, res, p.data.address, () => dexscreenerTokenPairs(p.data.chain, p.data.tokenAddress));
});
dataSourcesRouter.post("/coingecko/coin", async (req, res) => {
  const p = authSchema.extend({ coinId: z.string().min(1).max(100), vsCurrency: z.string().optional(), days: z.number().int().min(1).max(365).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and CoinGecko coin parameters are required." });
  return runProvider(req, res, p.data.address, () => coinGeckoCoin(p.data.coinId, p.data.vsCurrency, p.data.days));
});

// REAL-WORLD ASSETS
dataSourcesRouter.post("/defillama/protocols", async (req, res) => {
  const p = authSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address is required." });
  return runProvider(req, res, p.data.address, () => defiLlamaProtocols());
});
dataSourcesRouter.post("/defillama/tvl", async (req, res) => {
  const p = authSchema.extend({ protocol: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and protocol slug are required." });
  return runProvider(req, res, p.data.address, () => defiLlamaProtocolTvl(p.data.protocol));
});
dataSourcesRouter.post("/defillama/chain-tvl", async (req, res) => {
  const p = authSchema.extend({ chain: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and chain name are required." });
  return runProvider(req, res, p.data.address, () => defiLlamaHistoricalChainTvl(p.data.chain));
});

// SPORTS
dataSourcesRouter.post("/sports/sportmonks/fixtures", async (req, res) => {
  const p = authSchema.extend({ date: z.string().date() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and fixture date (YYYY-MM-DD) are required." });
  return runProvider(req, res, p.data.address, () => sportmonksFixtures(p.data.date));
});
dataSourcesRouter.post("/sports/api-football/fixtures", async (req, res) => {
  const p = authSchema.extend({ date: z.string().date(), league: z.number().int().positive().optional(), season: z.number().int().min(1900).max(2200).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and fixture date are required." });
  return runProvider(req, res, p.data.address, () => apiFootballFixtures(p.data.date, p.data.league, p.data.season));
});

// ECONOMIC & FINANCIAL
dataSourcesRouter.post("/economics/fred", async (req, res) => {
  const p = authSchema.extend({ seriesId: z.string().trim().min(1).max(80), start: z.string().date().optional(), end: z.string().date().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and FRED series ID are required." });
  return runProvider(req, res, p.data.address, () => fredObservations(p.data.seriesId, p.data.start, p.data.end));
});
dataSourcesRouter.post("/economics/world-bank", async (req, res) => {
  const p = authSchema.extend({ country: z.string().min(2).max(3), indicator: z.string().min(1).max(40), page: z.number().int().min(1).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address, country code and World Bank indicator are required." });
  return runProvider(req, res, p.data.address, () => worldBankIndicator(p.data.country, p.data.indicator, p.data.page));
});

// REGIONAL & GLOBAL EVENTS
dataSourcesRouter.post("/regional/gdelt", async (req, res) => {
  const p = authSchema.extend({ query: z.string().trim().min(1).max(250), maxRecords: z.number().int().min(1).max(250).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and GDELT query are required." });
  return runProvider(req, res, p.data.address, () => gdeltArticles(p.data.query, p.data.maxRecords));
});
dataSourcesRouter.post("/regional/open-meteo", async (req, res) => {
  const p = authSchema.extend({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), forecastDays: z.number().int().min(1).max(16).optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Valid admin address and coordinates are required." });
  return runProvider(req, res, p.data.address, () => openMeteoForecast(p.data.latitude, p.data.longitude, p.data.forecastDays));
});

export default dataSourcesRouter;
