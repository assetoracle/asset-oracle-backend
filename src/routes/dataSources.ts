import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { isAdminWallet } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";
import {
  dexscreenerSearch,
  dexscreenerTokenPairs,
  defiLlamaProtocols,
  defiLlamaProtocolTvl,
  footballMatches,
  fredObservations,
  gdeltArticles,
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

dataSourcesRouter.post("/dexscreener/search", async (req, res) => {
  const parsed = authSchema.extend({ query: z.string().trim().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and search query are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await dexscreenerSearch(parsed.data.query)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/dexscreener/token-pairs", async (req, res) => {
  const parsed = authSchema.extend({ chain: z.string().min(1).max(40), tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address, chain, and token contract address are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await dexscreenerTokenPairs(parsed.data.chain, parsed.data.tokenAddress)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/defillama/protocols", async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address is required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await defiLlamaProtocols()); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/defillama/tvl", async (req, res) => {
  const parsed = authSchema.extend({ protocol: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and protocol slug are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await defiLlamaProtocolTvl(parsed.data.protocol)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/sports/matches", async (req, res) => {
  const parsed = authSchema.extend({
    competition: z.enum(["PL", "PD", "BL1", "SA", "FL1", "CL"]),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and supported competition code are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await footballMatches(parsed.data.competition, parsed.data.dateFrom, parsed.data.dateTo)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/economics/fred", async (req, res) => {
  const parsed = authSchema.extend({
    seriesId: z.string().trim().min(1).max(80),
    start: z.string().date().optional(),
    end: z.string().date().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and FRED series ID are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await fredObservations(parsed.data.seriesId, parsed.data.start, parsed.data.end)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/regional/gdelt", async (req, res) => {
  const parsed = authSchema.extend({
    query: z.string().trim().min(1).max(250),
    maxRecords: z.number().int().min(1).max(250).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and GDELT query are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await gdeltArticles(parsed.data.query, parsed.data.maxRecords)); } catch (error) { return providerError(res, error); }
});

export default dataSourcesRouter;
