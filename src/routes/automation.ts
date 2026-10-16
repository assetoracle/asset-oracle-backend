import { Router } from "express";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { verifyWalletSession } from "../services/walletAuth.js";
import { isAdminWallet } from "../services/adminAuth.js";
import { CoinGeckoProvider } from "../automation/coingeckoProvider.js";
import { buildPriceThresholdCandidates } from "../automation/candidateBuilder.js";
import {
  listAutomationCandidates,
  reviewAutomationCandidate,
  upsertAutomationCandidates,
} from "../automation/candidateStore.js";
import type { StoredAutomationCandidate } from "../automation/candidateStore.js";

const automationRouter = Router();
const candidateStatus = z.enum(["PENDING_REVIEW", "DISMISSED", "PUBLISHED"]);

function sessionToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function automationEnabled(): boolean {
  return process.env.MARKET_AUTOMATION_ENABLED === "true";
}

async function requireAdmin(req: import("express").Request, res: import("express").Response, address: string): Promise<boolean> {
  if (!isAddress(address)) {
    res.status(400).json({ error: "A valid admin wallet address is required." });
    return false;
  }
  if (!await verifyWalletSession(sessionToken(req), address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address)) {
    res.status(403).json({ error: "Only the configured owner wallet can operate market automation." });
    return false;
  }
  return true;
}

/** Manual admin-only discovery. This route never publishes a transaction. */
automationRouter.post("/candidates/run", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: z.string(),
      assets: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid discovery request." });
    if (!await requireAdmin(req, res, parsed.data.address)) return;
    if (!automationEnabled()) return res.status(409).json({ error: "Market automation is disabled. Set MARKET_AUTOMATION_ENABLED=true only for a controlled test." });

    const configuredAssets = (process.env.MARKET_AUTOMATION_COINGECKO_ASSETS ?? "bitcoin,ethereum")
      .split(",").map((asset) => asset.trim().toLowerCase()).filter(Boolean);
    const requestedAssets = parsed.data.assets?.map((asset) => asset.toLowerCase());
    const assets = requestedAssets ?? configuredAssets;
    if (assets.length === 0 || assets.length > 20 || assets.some((asset) => !configuredAssets.includes(asset))) {
      return res.status(400).json({ error: "Requested assets must be selected from MARKET_AUTOMATION_COINGECKO_ASSETS." });
    }

    const provider = new CoinGeckoProvider({ apiKey: process.env.COINGECKO_API_KEY });
    let evidence;
    try {
      evidence = await provider.getUsdPrices(assets);
    } catch (error) {
      console.error("Market automation provider failure:", error instanceof Error ? error.message : "Unknown error");
      return res.status(502).json({ error: "The configured market data provider is temporarily unavailable." });
    }
    const generated = buildPriceThresholdCandidates(evidence);
    const persistence = await upsertAutomationCandidates(generated.candidates);
    return res.status(200).json({
      mode: "proposal-only",
      provider: generated.provider,
      generatedAt: generated.generatedAt,
      assetsRequested: assets.length,
      evidenceReturned: evidence.length,
      candidatesGenerated: generated.candidates.length,
      candidatesInserted: persistence.inserted,
      existingCandidates: persistence.existing,
      skipped: generated.skipped,
    });
  } catch (error) {
    return next(error);
  }
});

automationRouter.get("/candidates", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: z.string(),
      status: candidateStatus.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid candidate query." });
    if (!await requireAdmin(req, res, parsed.data.address)) return;
    const candidates: StoredAutomationCandidate[] = await listAutomationCandidates({
      status: parsed.data.status,
      limit: parsed.data.limit,
    });
    return res.status(200).json({ candidates, count: candidates.length });
  } catch (error) {
    return next(error);
  }
});

/** Admin review is audited and can only move pending <-> dismissed. */
automationRouter.post("/candidates/:id/review", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: z.string(),
      action: z.enum(["DISMISS", "RESTORE"]),
      reason: z.string().trim().min(3).max(500),
    }).safeParse(req.body);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success || !id.success) {
      return res.status(400).json({ error: "A valid candidate ID, admin address, action, and review reason are required." });
    }
    if (!await requireAdmin(req, res, parsed.data.address)) return;
    const candidate = await reviewAutomationCandidate({
      id: id.data,
      adminWallet: getAddress(parsed.data.address),
      action: parsed.data.action,
      reason: parsed.data.reason,
    });
    if (!candidate) {
      return res.status(409).json({ error: "Candidate not found or no longer in the state required for this review action." });
    }
    return res.status(200).json({
      message: parsed.data.action === "DISMISS" ? "Candidate dismissed." : "Candidate restored to pending review.",
      candidate,
    });
  } catch (error) {
    return next(error);
  }
});

export default automationRouter;
