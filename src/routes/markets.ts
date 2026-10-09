import { Router } from "express";
import { marketProposalSchema } from "../services/marketValidation.js";
import {
  createMarketProposal,
  listMarketProposals,
  getMarketProposal,
} from "../services/marketStore.js";

const marketsRouter = Router();

marketsRouter.post("/proposals/validate", (req, res) => {
  const result = marketProposalSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      valid: false,
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return res.status(200).json({
    valid: true,
    message: "Market proposal passed structural validation.",
    proposal: result.data,
    status: "PENDING_APPROVAL",
    persisted: false,
  });
});

marketsRouter.post("/proposals", (req, res) => {
  const result = marketProposalSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid market proposal",
      details: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const proposal = createMarketProposal(result.data);

  return res.status(201).json({
    message: "Market proposal submitted for approval.",
    proposal,
  });
});

marketsRouter.get("/proposals", (_req, res) => {
  return res.status(200).json({
    proposals: listMarketProposals(),
    count: listMarketProposals().length,
  });
});

marketsRouter.get("/proposals/:id", (req, res) => {
  const proposal = getMarketProposal(req.params.id);

  if (!proposal) {
    return res.status(404).json({
      error: "Market proposal not found",
    });
  }

  return res.status(200).json({ proposal });
});

export default marketsRouter;