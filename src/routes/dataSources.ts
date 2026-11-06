import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { isAdminWallet } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";
import { database } from "../config/database.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import {
  apiFootballFixtures,
  coingeckoMarkets,
  dexscreenerSearch,
  dexscreenerTokenPairs,
  defiLlamaProtocols,
  defiLlamaProtocolTvl,
  fredObservations,
  gdeltArticles,
  openMeteoHistorical,
  sportmonksFixturesByDate,
  worldBankIndicator,
} from "../services/dataProviders.js";

const dataSourcesRouter = Router();
dataSourcesRouter.use(createRateLimiter({ windowMs: 60_000, max: 30, message: "Provider query limit reached. Wait before requesting more data." }));
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

function providerError(res: import("express").Response, _error: unknown) {
  return res.status(502).json({ error: "Data provider request failed. Check server logs for the provider and request status." });
}

dataSourcesRouter.post("/coingecko/markets", async (req, res) => {
  const parsed = authSchema.extend({
    vsCurrency: z.string().trim().min(2).max(12).optional(),
    page: z.number().int().min(1).max(1000).optional(),
    perPage: z.number().int().min(1).max(250).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and CoinGecko market parameters are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await coingeckoMarkets(parsed.data.vsCurrency, parsed.data.page, parsed.data.perPage)); } catch (error) { return providerError(res, error); }
});

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

dataSourcesRouter.post("/sports/sportmonks/fixtures", async (req, res) => {
  const parsed = authSchema.extend({ date: z.string().date() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and fixture date are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await sportmonksFixturesByDate(parsed.data.date)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/sports/api-football/fixtures", async (req, res) => {
  const parsed = authSchema.extend({
    date: z.string().date(),
    league: z.number().int().positive().optional(),
    season: z.number().int().min(1900).max(2200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and API-Football fixture parameters are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await apiFootballFixtures(parsed.data.date, parsed.data.league, parsed.data.season)); } catch (error) { return providerError(res, error); }
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

dataSourcesRouter.post("/economics/world-bank", async (req, res) => {
  const parsed = authSchema.extend({
    country: z.string().trim().min(2).max(3),
    indicator: z.string().trim().min(1).max(80),
    dateRange: z.string().regex(/^\d{4}:\d{4}$/).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address, country code, and World Bank indicator are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await worldBankIndicator(parsed.data.country, parsed.data.indicator, parsed.data.dateRange)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/regional/gdelt", async (req, res) => {
  const parsed = authSchema.extend({
    query: z.string().trim().min(1).max(250),
    maxRecords: z.number().int().min(1).max(250).optional(),
    timespan: z.string().regex(/^(15min|[1-9]\\d*(min|h|hours|d|days|w|weeks|m|months))$/).max(12).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and GDELT query are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await gdeltArticles(parsed.data.query, parsed.data.maxRecords, parsed.data.timespan)); } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/regional/open-meteo/historical", async (req, res) => {
  const parsed = authSchema.extend({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    startDate: z.string().date(),
    endDate: z.string().date(),
  }).refine((value) => value.startDate <= value.endDate, "Start date must not be after end date").safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address, coordinates, and date range are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try { return res.json(await openMeteoHistorical(parsed.data.latitude, parsed.data.longitude, parsed.data.startDate, parsed.data.endDate)); } catch (error) { return providerError(res, error); }
});


const chainId = 42421;

dataSourcesRouter.post("/asset-chain/indexer/status", async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address is required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const [cursor, counts] = await Promise.all([
      database.query("SELECT start_block,last_indexed_block,last_block_hash,updated_at FROM asset_chain_indexer_cursors WHERE chain_id=$1", [chainId]),
      database.query(`SELECT
        (SELECT COUNT(*) FROM asset_chain_blocks WHERE chain_id=$1) AS blocks,
        (SELECT COUNT(*) FROM asset_chain_transactions WHERE chain_id=$1) AS transactions,
        (SELECT COUNT(*) FROM asset_chain_logs WHERE chain_id=$1) AS logs,
        (SELECT COUNT(*) FROM asset_chain_transfers WHERE chain_id=$1) AS transfers,
        (SELECT COUNT(*) FROM asset_chain_wallets WHERE chain_id=$1) AS wallets`, [chainId]),
    ]);
    return res.json({
      enabled: process.env.ASSET_CHAIN_INDEXER_ENABLED === "true",
      chainId,
      cursor: cursor.rows[0] ?? null,
      totals: counts.rows[0] ?? null,
    });
  } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/asset-chain/wallet", async (req, res) => {
  const parsed = authSchema.extend({
    wallet: z.string().refine(isAddress, "Invalid wallet address"),
    limit: z.number().int().min(1).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and wallet address are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const limit = parsed.data.limit ?? 50;
    const [wallet, transactions, transfers] = await Promise.all([
      database.query("SELECT * FROM asset_chain_wallets WHERE chain_id=$1 AND wallet_address=lower($2)", [chainId, parsed.data.wallet]),
      database.query(`SELECT tx_hash,block_number,transaction_index,from_address,to_address,value_wei,receipt_status,gas_used
        FROM asset_chain_transactions WHERE chain_id=$1 AND (from_address=lower($2) OR to_address=lower($2))
        ORDER BY block_number DESC,transaction_index DESC LIMIT $3`, [chainId, parsed.data.wallet, limit]),
      database.query(`SELECT tx_hash,block_number,transfer_type,token_address,from_address,to_address,amount_raw
        FROM asset_chain_transfers WHERE chain_id=$1 AND (from_address=lower($2) OR to_address=lower($2))
        ORDER BY block_number DESC,log_index DESC LIMIT $3`, [chainId, parsed.data.wallet, limit]),
    ]);
    return res.json({ wallet: wallet.rows[0] ?? null, transactions: transactions.rows, transfers: transfers.rows });
  } catch (error) { return providerError(res, error); }
});

dataSourcesRouter.post("/asset-chain/contract-events", async (req, res) => {
  const parsed = authSchema.extend({
    contract: z.string().refine(isAddress, "Invalid contract address"),
    limit: z.number().int().min(1).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valid admin address and contract address are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const events = await database.query(`SELECT tx_hash,log_index,block_number,contract_address,topics,data,removed
      FROM asset_chain_logs WHERE chain_id=$1 AND contract_address=lower($2)
      ORDER BY block_number DESC,log_index DESC LIMIT $3`, [chainId, parsed.data.contract, parsed.data.limit ?? 50]);
    return res.json({ events: events.rows });
  } catch (error) { return providerError(res, error); }
});

export default dataSourcesRouter;

