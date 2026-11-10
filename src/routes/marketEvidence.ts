import { Router } from "express";
import { z } from "zod";
import { isAddress, getAddress } from "viem";
import { isAdminWallet, isHumanValidator } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";
import { collectMarketEvidence } from "../services/marketEvidenceCollector.js";
import { getResolutionRecommendation } from "../services/marketResolutionVerification.js";
import { listMarketEvidence } from "../services/marketEvidenceStore.js";
import { listEvidenceReviews, listEvidenceReviewQueue, submitEvidenceReview } from "../services/marketEvidenceReviewStore.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = Router();
router.use(createRateLimiter({ windowMs: 60_000, max: 20, message: "Market evidence request limit reached. Wait before trying again." }));
const proposalIdSchema = z.string().uuid();
const evidenceIdSchema = z.string().uuid();
const addressSchema = z.string().refine(isAddress, "Invalid wallet address");

function sessionToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function authorizeOwner(req: import("express").Request, res: import("express").Response, address: string): Promise<boolean> {
  if (!await verifyWalletSession(sessionToken(req), address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address)) {
    res.status(403).json({ error: "Only the configured owner wallet can collect provider evidence." });
    return false;
  }
  return true;
}

async function authorizeEvidenceReviewer(req: import("express").Request, res: import("express").Response, address: string): Promise<boolean> {
  if (!await verifyWalletSession(sessionToken(req), address)) {
    res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    return false;
  }
  if (!isAdminWallet(address) && !isHumanValidator(address)) {
    res.status(403).json({ error: "Only the owner or a configured human validator can inspect provider evidence." });
    return false;
  }
  return true;
}

router.post("/:proposalId/resolution", async (req, res, next) => {
  const parsed = z.object({ proposalId: proposalIdSchema, address: addressSchema }).safeParse({ proposalId: req.params.proposalId, address: req.body?.address });
  if (!parsed.success) return res.status(400).json({ error: "A valid proposal ID and validator wallet address are required." });
  if (!await authorizeEvidenceReviewer(req, res, parsed.data.address)) return;
  try {
    const recommendation = await getResolutionRecommendation(parsed.data.proposalId);
    if (!recommendation) return res.status(404).json({ error: "No resolution-time provider recommendation has been prepared for this market." });
    return res.status(200).json({ recommendation });
  } catch (error) { return next(error); }
});

router.post("/:proposalId/collect", async (req, res, next) => {
  const parsed = z.object({ proposalId: proposalIdSchema, address: addressSchema }).safeParse({
    proposalId: req.params.proposalId, address: req.body?.address,
  });
  if (!parsed.success) return res.status(400).json({ error: "A valid proposal ID and owner wallet address are required." });
  if (!await authorizeOwner(req, res, parsed.data.address)) return;
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
  if (!parsed.success) return res.status(400).json({ error: "A valid proposal ID and wallet address are required." });
  if (!await authorizeEvidenceReviewer(req, res, parsed.data.address)) return;
  try {
    const [evidence, reviews] = await Promise.all([
      listMarketEvidence(parsed.data.proposalId),
      listEvidenceReviews(parsed.data.proposalId),
    ]);
    const enriched = evidence.map((item) => {
      const itemReviews = reviews.filter((review) => review.evidenceId === item.id);
      return {
        ...item,
        acceptedReviews: itemReviews.filter((review) => review.decision === "ACCEPTED").length,
        rejectedReviews: itemReviews.filter((review) => review.decision === "REJECTED").length,
        reviews: itemReviews,
        myDecision: itemReviews.find((review) => review.validatorAddress.toLowerCase() === getAddress(parsed.data.address).toLowerCase())?.decision ?? null,
      };
    });
    return res.status(200).json({ evidence: enriched, count: enriched.length });
  } catch (error) { return next(error); }
});

router.post("/review-queue", async (req, res, next) => {
  const parsed = z.object({ address: addressSchema }).safeParse({
    address: req.body?.address,
  });
  if (!parsed.success) return res.status(400).json({ error: "A valid validator wallet address is required." });
  if (!await authorizeEvidenceReviewer(req, res, parsed.data.address)) return;
  try {
    const evidence = await listEvidenceReviewQueue(getAddress(parsed.data.address));
    return res.status(200).json({ evidence, count: evidence.length });
  } catch (error) {
    return next(error);
  }
});

router.post("/:proposalId/:evidenceId/review", async (req, res, next) => {
  const parsed = z.object({
    proposalId: proposalIdSchema,
    evidenceId: evidenceIdSchema,
    address: addressSchema,
    decision: z.enum(["ACCEPTED", "REJECTED"]),
    note: z.string().trim().max(500).optional(),
  }).safeParse({
    proposalId: req.params.proposalId,
    evidenceId: req.params.evidenceId,
    address: req.body?.address,
    decision: req.body?.decision,
    note: req.body?.note,
  });
  if (!parsed.success) return res.status(400).json({ error: "A valid proposal, evidence record, validator wallet, and review decision are required." });
  if (!await verifyWalletSession(sessionToken(req), parsed.data.address)) {
    return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
  }
  if (!isHumanValidator(parsed.data.address)) {
    return res.status(403).json({ error: "Only configured human validators can review provider evidence." });
  }
  try {
    const result = await submitEvidenceReview({
      proposalId: parsed.data.proposalId,
      evidenceId: parsed.data.evidenceId,
      validatorAddress: getAddress(parsed.data.address),
      decision: parsed.data.decision,
      note: parsed.data.note,
    });
    return res.status(201).json({ message: "Validator evidence review recorded.", ...result });
  } catch (error) {
    if (error instanceof Error && /not found/.test(error.message)) return res.status(404).json({ error: error.message });
    if (error instanceof Error && /already reviewed|already has a final/.test(error.message)) return res.status(409).json({ error: error.message });
    return next(error);
  }
});

export default router;
