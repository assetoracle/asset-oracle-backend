import { Router } from "express";
import { z } from "zod";
import { isAddress } from "viem";
import { isAdminWallet } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";
import { collectMarketEvidence } from "../services/marketEvidenceCollector.js";
import { listMarketEvidence } from "../services/marketEvidenceStore.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = Router();
router.use(createRateLimiter({ windowMs: 60_000, max: 10, message: "Market evidence request limit reached. Wait before collecting more evidence." }));
const proposalIdSchema = z.string().uuid();
const addressSchema = z.string().refine(isAddress, "Invalid wallet address");

async function authorize(req: import("express").Request, res: import("express").Response, address: string): Promise<boolean> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!await verifyWalletSession(token, address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address)) {
    res.status(403).json({ error: "Only the configured admin wallet can collect or inspect market evidence." });
    return false;
  }
  return true;
}

router.post("/:proposalId/collect", async (req, res, next) => {
  const parsed = z.object({ proposalId: proposalIdSchema, address: addressSchema }).safeParse({
    proposalId: req.params.proposalId, address: req.body?.address,
  });
  if (!parsed.success) return res.status(400).json({ error: "A valid proposal ID and admin wallet address are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const result = await collectMarketEvidence(parsed.data.proposalId);
    return res.status(result.inserted ? 201 : 200).json({
      message: result.inserted ? "Market evidence collected and stored for validator review." : "This provider response was already stored.",
      evidence: result.evidence,
      inserted: result.inserted,
    });
  } catch (error) {
    if (error instanceof Error && /not found/.test(error.message)) return res.status(404).json({ error: error.message });
    if (error instanceof Error && /approved|provider|requires|category|query|published/.test(error.message)) return res.status(409).json({ error: error.message });
    return next(error);
  }
});

router.post("/:proposalId/list", async (req, res, next) => {
  const parsed = z.object({ proposalId: proposalIdSchema, address: addressSchema }).safeParse({
    proposalId: req.params.proposalId, address: req.body?.address,
  });
  if (!parsed.success) return res.status(400).json({ error: "A valid proposal ID and admin wallet address are required." });
  if (!await authorize(req, res, parsed.data.address)) return;
  try {
    const evidence = await listMarketEvidence(parsed.data.proposalId);
    return res.status(200).json({ evidence, count: evidence.length });
  } catch (error) { return next(error); }
});

export default router;
