import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { isAdminWallet, isMarketCreatorWallet } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";
import {
  listPendingMarketCandidates,
  reviewMarketCandidate,
} from "../services/marketGenerationStore.js";

const router = Router();
router.use(createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: "Market candidate review limit reached. Wait before trying again.",
}));

const addressSchema = z.string().refine(isAddress, "Invalid wallet address");
const candidateIdSchema = z.string().uuid();

function sessionToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function authorize(
  req: import("express").Request,
  res: import("express").Response,
  address: string,
): Promise<boolean> {
  if (!await verifyWalletSession(sessionToken(req), address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address) && !isMarketCreatorWallet(address)) {
    res.status(403).json({ error: "Only the configured admin or market creator wallets can review generated candidates." });
    return false;
  }
  return true;
}

router.post("/admin/list/session", async (req, res, next) => {
  const parsed = z.object({
    address: addressSchema,
    limit: z.number().int().min(1).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "A valid reviewer wallet address is required." });
  }
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const candidates = await listPendingMarketCandidates(parsed.data.limit ?? 50);
    return res.status(200).json({ candidates, count: candidates.length });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/:candidateId/decision/session", async (req, res, next) => {
  const parsed = z.object({
    candidateId: candidateIdSchema,
    address: addressSchema,
    decision: z.enum(["DISMISSED", "PROMOTED"]),
  }).safeParse({
    candidateId: req.params.candidateId,
    address: req.body?.address,
    decision: req.body?.decision,
  });
  if (!parsed.success) {
    return res.status(400).json({ error: "A valid candidate ID, reviewer wallet address, and decision are required." });
  }
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const result = await reviewMarketCandidate({
      candidateId: parsed.data.candidateId,
      decision: parsed.data.decision,
      reviewerAddress: parsed.data.address,
    });
    if (result.result === "NOT_FOUND") {
      return res.status(404).json({ error: "Generated market candidate not found." });
    }
    if (result.result === "CONFLICT") {
      return res.status(409).json({ error: "This candidate has already been reviewed. Refresh the candidate queue." });
    }
    return res.status(200).json({
      message: parsed.data.decision === "PROMOTED"
        ? "Candidate promoted into the private automated market queue for market-maker approval."
        : "Candidate dismissed.",
      decision: parsed.data.decision,
      ...(result.proposal ? { proposal: result.proposal } : {}),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
