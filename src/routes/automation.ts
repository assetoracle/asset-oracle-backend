import { Router } from "express";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { verifyWalletSession } from "../services/walletAuth.js";
import { isAdminWallet } from "../services/adminAuth.js";
import { CoinGeckoProvider } from "../automation/coingeckoProvider.js";
import { buildPriceThresholdCandidates } from "../automation/candidateBuilder.js";
import {
  approveAutomationCandidate,
  listAutomationCandidates,
  reviewAutomationCandidate,
  upsertAutomationCandidates,
} from "../automation/candidateStore.js";
import type { StoredAutomationCandidate } from "../automation/candidateStore.js";

const automationRouter = Router();
const candidateStatus = z.enum(["PENDING_REVIEW", "DISMISSED", "APPROVED_FOR_PUBLICATION", "PUBLISHED"]);

function sessionToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function automationEnabled(): boolean {
  return process.env.MARKET_AUTOMATION_ENABLED === "true";
}

function configuredMarketMakers(): string[] {
  return (process.env.MARKET_CREATOR_WALLET_ADDRESSES ?? process.env.MARKET_MAKER_WALLET_ADDRESSES ?? "")
    .split(",").map((value) => value.trim()).filter(isAddress).map((value) => getAddress(value));
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

async function requireMarketReviewer(req: import("express").Request, res: import("express").Response, address: string): Promise<boolean> {
  if (!isAddress(address)) {
    res.status(400).json({ error: "A valid reviewer wallet address is required." });
    return false;
  }
  if (!await verifyWalletSession(sessionToken(req), address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address) && !configuredMarketMakers().includes(getAddress(address))) {
    res.status(403).json({ error: "Only the owner or configured market creator wallets can review automated candidates." });
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

    const configuredAssetValue = process.env.MARKET_AUTOMATION_COINGECKO_ASSETS
      ?? (process.env.NODE_ENV === "production" ? "" : "bitcoin,ethereum");
    const configuredAssets = [...new Set(configuredAssetValue
      .split(",").map((asset) => asset.trim().toLowerCase()).filter(Boolean))];
    const requestedAssets = parsed.data.assets?.map((asset) => asset.toLowerCase());
    const assets = requestedAssets ?? configuredAssets;
    if (assets.length === 0 || assets.length > 20 || assets.some((asset) => !configuredAssets.includes(asset))) {
      return res.status(400).json({ error: "Requested assets must be selected from MARKET_AUTOMATION_COINGECKO_ASSETS." });
    }

    const { acquireAutomationRunLock } = await import("../automation/distributedLock.js");
    const releaseLock = await acquireAutomationRunLock();
    if (!releaseLock) {
      return res.status(409).json({ error: "Another automation run is active. Retry after it completes." });
    }
    try {
      const provider = new CoinGeckoProvider({ apiKey: process.env.COINGECKO_API_KEY });
      let evidence;
      try {
        evidence = await provider.getUsdPrices(assets);
      } catch (error) {
        console.error("Market automation provider failure:", error instanceof Error ? error.message : "Unknown error");
        return res.status(502).json({ error: "The configured market data provider is temporarily unavailable." });
      }
      const { recordProviderObservations } = await import("../automation/candidateStore.js");
      await recordProviderObservations(evidence);
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
    } finally {
      await releaseLock();
    }
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
    if (!await requireMarketReviewer(req, res, parsed.data.address)) return;
    const candidates: StoredAutomationCandidate[] = await listAutomationCandidates({
      status: parsed.data.status,
      limit: parsed.data.limit,
    });
    return res.status(200).json({ candidates, count: candidates.length });
  } catch (error) {
    return next(error);
  }
});

/** Any one of the configured admin or two market makers can approve a candidate. */
automationRouter.post("/candidates/:id/approve", async (req, res, next) => {
  try {
    const parsed = z.object({ address: z.string() }).safeParse(req.body);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success || !id.success || !isAddress(parsed.data.address)) {
      return res.status(400).json({ error: "A valid candidate ID and approver address are required." });
    }
    const address = getAddress(parsed.data.address);
    if (!await verifyWalletSession(sessionToken(req), address)) {
      return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    }
    const adminAddress = process.env.ADMIN_WALLET_ADDRESS?.trim();
    const makers = (process.env.MARKET_MAKER_WALLET_ADDRESSES ?? "")
      .split(",").map((value) => value.trim()).filter((value) => isAddress(value)).map((value) => getAddress(value));
    const isAdmin = Boolean(adminAddress && isAddress(adminAddress) && getAddress(adminAddress) === address);
    const isMaker = makers.includes(address);
    if (!isAdmin && !isMaker) {
      return res.status(403).json({ error: "Only the owner or configured market creators can approve candidates." });
    }
    if (new Set([...(adminAddress && isAddress(adminAddress) ? [getAddress(adminAddress)] : []), ...makers]).size !== 3) {
      return res.status(503).json({ error: "Configure one admin wallet and exactly two distinct market-maker wallets before enabling approvals." });
    }
    const result = await approveAutomationCandidate({
      id: id.data,
      approverWallet: address,
      approverRole: isAdmin ? "ADMIN" : "MARKET_MAKER",
    });
    if (!result) {
      return res.status(409).json({ error: "Candidate is unavailable for approval or is already dismissed/published." });
    }
    return res.status(200).json({
      message: result.newlyApproved
        ? "Candidate approved by the 1-of-3 threshold. It is ready for the authorized publication step."
        : "Approval recorded; the candidate remains approved for publication.",
      approvalCount: result.approvalCount,
      requiredApprovals: 1,
      status: result.candidate.status,
      candidate: result.candidate,
      publishedOnchain: false,
    });
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
