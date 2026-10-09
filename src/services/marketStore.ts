import { Router } from "express";
import { z } from "zod";
import { marketProposalSchema } from "../services/marketValidation.js";
import {
  createMarketProposal,
  getMarketProposal,
  listMarketProposals,
} from "../services/marketStore.js";

const marketsRouter = Router();

marketsRouter.post("/proposals/validate", (req, res) => {
  const result = marketProposalSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Market proposal validation failed",
      details: result.error.issues,
    });
  }

  return res.status(200).json({
    valid: true,
    proposal: result.data,
  });
});

marketsRouter.post("/proposals", async (req, res, next) => {
  try {
    const result = marketProposalSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Market proposal validation failed",
        details: result.error.issues,
      });
    }

    const proposal = await createMarketProposal(result.data);

    return res.status(201).json({
      message: "Market proposal submitted successfully",
      proposal,
    });
  } catch (error) {
    return next(error);
  }
});

marketsRouter.get("/proposals", async (_req, res, next) => {
  try {
    const proposals = await listMarketProposals();

    return res.status(200).json({
      proposals,
      count: proposals.length,
    });
  } catch (error) {
    return next(error);
  }
});

marketsRouter.get(
  "/proposals/:id",
  async (req, res, next) => {
    try {
      const idResult = z.string().uuid().safeParse(req.params.id);

      if (!idResult.success) {
        return res.status(400).json({
          error: "Invalid proposal ID",
        });
      }

      const proposal = await getMarketProposal(idResult.data);

      if (!proposal) {
        return res.status(404).json({
          error: "Market proposal not found",
        });
      }

      return res.status(200).json({ proposal });
    } catch (error) {
      return next(error);
    }
  },
);

export default marketsRouter;