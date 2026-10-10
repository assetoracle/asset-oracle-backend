import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { marketProposalSchema } from "../services/marketValidation.js";
import { verifyAdminWallet } from "../services/adminAuth.js";
import {
  createMarketProposal,
  getMarketProposal,
  listPublishedMarkets,
  listMarketProposals,
  listMarketProposalsByWallet,
  updateMarketProposalStatus,
} from "../services/marketStore.js";
import {
  createWalletNonce,
  verifyWalletSignature,
} from "../services/walletAuth.js";

const marketsRouter = Router();

const walletAuthSchema = z.object({
  address: z.string().refine(isAddress, "Invalid wallet address"),
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "Invalid signature"),
});

marketsRouter.post("/auth/nonce", async (req, res, next) => {
  try {
    const result = z.object({
      address: z.string().refine(isAddress, "Invalid wallet address"),
    }).safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "A valid wallet address is required",
      });
    }

    const nonce = await createWalletNonce(result.data.address);
    const message =
      `Asset Oracle wallet verification\n` +
      `Address: ${result.data.address}\n` +
      `Nonce: ${nonce}`;

    return res.status(200).json({ nonce, message });
  } catch (error) {
    return next(error);
  }
});

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

marketsRouter.post("/proposals", async (req, res, next) => {
  try {
    const bodyResult = z.object({
      proposal: marketProposalSchema,
      walletAuth: walletAuthSchema,
    }).safeParse(req.body);

    if (!bodyResult.success) {
      return res.status(400).json({
        error: "A valid proposal and wallet authentication are required",
        details: bodyResult.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const { proposal: input, walletAuth } = bodyResult.data;

    const verified = await verifyWalletSignature(
      walletAuth.address,
      walletAuth.signature as `0x${string}`,
      walletAuth.message,
    );

    if (!verified) {
      return res.status(401).json({
        error: "Wallet verification failed. Request a new nonce and sign again.",
      });
    }

    const stored = await createMarketProposal(
      input,
      walletAuth.address,
    );

    return res.status(201).json({
      message: "Market proposal submitted for approval.",
      proposal: stored,
    });
  } catch (error) {
    return next(error);
  }
});

marketsRouter.post("/proposals/mine", async (req, res, next) => {
  try {
    const result = walletAuthSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Valid wallet authentication is required",
      });
    }

    const { address, message, signature } = result.data;
    const verified = await verifyWalletSignature(
      address,
      signature as `0x${string}`,
      message,
    );

    if (!verified) {
      return res.status(401).json({
        error: "Wallet verification failed. Request a new nonce and sign again.",
      });
    }

    const proposals = await listMarketProposalsByWallet(address);

    return res.status(200).json({
      proposals,
      count: proposals.length,
    });
  } catch (error) {
    return next(error);
  }
});


marketsRouter.get("/public", async (_req, res, next) => {
  try {
    const markets = await listPublishedMarkets();

    return res.status(200).json({
      markets,
      count: markets.length,
    });
  } catch (error) {
    return next(error);
  }
});

marketsRouter.get("/proposals/:id", async (req, res, next) => {
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
});


marketsRouter.post("/admin/proposals/list", async (req, res, next) => {
  try {
    const result = walletAuthSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Valid admin wallet authentication is required",
      });
    }

    const { address, message, signature } = result.data;

    const verified = await verifyAdminWallet(
      address,
      signature as `0x${string}`,
      message,
    );

    if (!verified) {
      return res.status(403).json({
        error: "Admin authorization failed",
      });
    }

    const proposals = await listMarketProposals();

    return res.status(200).json({
      proposals,
      count: proposals.length,
    });
  } catch (error) {
    return next(error);
  }
});

marketsRouter.post(
  "/admin/proposals/:id/decision",
  async (req, res, next) => {
    try {
      const idResult = z.string().uuid().safeParse(req.params.id);

      if (!idResult.success) {
        return res.status(400).json({
          error: "Invalid proposal ID",
        });
      }

      const bodyResult = z.object({
        status: z.enum(["APPROVED", "REJECTED"]),
        walletAuth: walletAuthSchema,
      }).safeParse(req.body);

      if (!bodyResult.success) {
        return res.status(400).json({
          error: "A valid decision and admin authentication are required",
        });
      }

      const { status, walletAuth } = bodyResult.data;

      const verified = await verifyAdminWallet(
        walletAuth.address,
        walletAuth.signature as `0x${string}`,
        walletAuth.message,
      );

      if (!verified) {
        return res.status(403).json({
          error: "Admin authorization failed",
        });
      }

      const proposal = await updateMarketProposalStatus(
        idResult.data,
        status,
      );

      if (!proposal) {
        const existing = await getMarketProposal(idResult.data);

        if (!existing) {
          return res.status(404).json({
            error: "Market proposal not found",
          });
        }

        return res.status(409).json({
          error: "Only pending proposals can receive a decision",
          status: existing.status,
        });
      }

      return res.status(200).json({
        message: `Market proposal ${status.toLowerCase()}.`,
        proposal,
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default marketsRouter;