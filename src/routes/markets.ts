import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { marketProposalSchema } from "../services/marketValidation.js";
import { getWalletRole, isMarketCreatorWallet, verifyAdminWallet } from "../services/adminAuth.js";
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

type MarketRouteDependencies = {
  getWalletRole: typeof getWalletRole;
  isMarketCreatorWallet: typeof isMarketCreatorWallet;
  verifyAdminWallet: typeof verifyAdminWallet;
  createMarketProposal: typeof createMarketProposal;
  getMarketProposal: typeof getMarketProposal;
  listPublishedMarkets: typeof listPublishedMarkets;
  listMarketProposals: typeof listMarketProposals;
  listMarketProposalsByWallet: typeof listMarketProposalsByWallet;
  updateMarketProposalStatus: typeof updateMarketProposalStatus;
  createWalletNonce: typeof createWalletNonce;
  verifyWalletSignature: typeof verifyWalletSignature;
};

const defaultDependencies: MarketRouteDependencies = {
  getWalletRole, isMarketCreatorWallet, verifyAdminWallet,
  createMarketProposal, getMarketProposal, listPublishedMarkets,
  listMarketProposals, listMarketProposalsByWallet, updateMarketProposalStatus,
  createWalletNonce, verifyWalletSignature,
};

export function createMarketsRouter(dependencies: MarketRouteDependencies = defaultDependencies) {
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

    const nonce = await dependencies.createWalletNonce(result.data.address);
    const message =
      `Asset Oracle wallet verification\n` +
      `Address: ${result.data.address}\n` +
      `Nonce: ${nonce}`;

    return res.status(200).json({ nonce, message });
  } catch (error) {
    return next(error);
  }
});


marketsRouter.post("/auth/role", async (req, res, next) => {
  try {
    const result = walletAuthSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Valid wallet authentication is required",
      });
    }

    const { address, message, signature } = result.data;
    const verified = await dependencies.verifyWalletSignature(
      address,
      signature as `0x${string}`,
      message,
    );

    if (!verified) {
      return res.status(401).json({
        error: "Wallet verification failed. Request a new nonce and sign again.",
      });
    }

    return res.status(200).json({
      address,
      role: dependencies.getWalletRole(address),
      permissions: {
        createMarketProposal: dependencies.isMarketCreatorWallet(address),
        viewOwnProposals: true,
        reviewAllProposals: dependencies.getWalletRole(address) === "OWNER",
        approveOrRejectProposals: dependencies.getWalletRole(address) === "OWNER",
      },
    });
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

    const verified = await dependencies.verifyWalletSignature(
      walletAuth.address,
      walletAuth.signature as `0x${string}`,
      walletAuth.message,
    );

    if (!verified) {
      return res.status(401).json({
        error: "Wallet verification failed. Request a new nonce and sign again.",
      });
    }

    // Submission is restricted server-side to the owner and configured market
    // creators. Frontend navigation is not an authorization boundary.
    if (!dependencies.isMarketCreatorWallet(walletAuth.address)) {
      return res.status(403).json({
        error: "Only the owner or an authorized market creator can submit proposals.",
      });
    }

    const stored = await dependencies.createMarketProposal(
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
    const verified = await dependencies.verifyWalletSignature(
      address,
      signature as `0x${string}`,
      message,
    );

    if (!verified) {
      return res.status(401).json({
        error: "Wallet verification failed. Request a new nonce and sign again.",
      });
    }

    const proposals = await dependencies.listMarketProposalsByWallet(address);

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
    const markets = await dependencies.listPublishedMarkets();

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

    const proposal = await dependencies.getMarketProposal(idResult.data);

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

    const verified = await dependencies.verifyAdminWallet(
      address,
      signature as `0x${string}`,
      message,
    );

    if (!verified) {
      return res.status(403).json({
        error: "Admin authorization failed",
      });
    }

    const proposals = await dependencies.listMarketProposals();

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

      const verified = await dependencies.verifyAdminWallet(
        walletAuth.address,
        walletAuth.signature as `0x${string}`,
        walletAuth.message,
      );

      if (!verified) {
        return res.status(403).json({
          error: "Admin authorization failed",
        });
      }

      const proposal = await dependencies.updateMarketProposalStatus(
        idResult.data,
        status,
      );

      if (!proposal) {
        const existing = await dependencies.getMarketProposal(idResult.data);

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

return marketsRouter;
}

export default createMarketsRouter();