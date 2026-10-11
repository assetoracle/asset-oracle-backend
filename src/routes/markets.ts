import { Router } from "express";
import { createPublicClient, getAddress, http, isAddress, parseEventLogs } from "viem";
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
  recordOnchainPublication,
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


marketsRouter.post("/auth/role", async (req, res, next) => {
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

    return res.status(200).json({
      address,
      role: getWalletRole(address),
      permissions: {
        createMarketProposal: true,
        viewOwnProposals: true,
        reviewAllProposals: getWalletRole(address) === "OWNER",
        approveOrRejectProposals: getWalletRole(address) === "OWNER",
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


const marketCreatedAbi = [{
  type: "event",
  name: "MarketCreated",
  anonymous: false,
  inputs: [
    { indexed: true, name: "marketId", type: "uint256" },
    { indexed: true, name: "creator", type: "address" },
    { indexed: false, name: "stablecoin", type: "uint8" },
    { indexed: false, name: "closeTime", type: "uint64" },
    { indexed: false, name: "question", type: "string" },
  ],
}] as const;

marketsRouter.post("/admin/proposals/:id/publish", async (req, res, next) => {
  try {
    const idResult = z.string().uuid().safeParse(req.params.id);
    const bodyResult = z.object({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      marketId: z.string().regex(/^[1-9][0-9]*$/),
      walletAuth: walletAuthSchema,
    }).safeParse(req.body);
    if (!idResult.success || !bodyResult.success) {
      return res.status(400).json({ error: "A valid proposal ID, transaction hash, market ID, and wallet authentication are required." });
    }

    const { txHash, marketId, walletAuth } = bodyResult.data;
    const verified = await verifyWalletSignature(
      walletAuth.address,
      walletAuth.signature as `0x${string}`,
      walletAuth.message,
    );
    if (!verified || !isMarketCreatorWallet(walletAuth.address)) {
      return res.status(403).json({ error: "An authenticated, configured market-creator wallet is required." });
    }

    const proposal = await getMarketProposal(idResult.data);
    if (!proposal) return res.status(404).json({ error: "Market proposal not found." });
    if (proposal.status !== "APPROVED") {
      return res.status(409).json({ error: "Only approved proposals can be linked to an on-chain market." });
    }

    const manager = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
    const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || "https://enugu-rpc.assetchain.org";
    const expectedChainId = Number(process.env.ASSET_CHAIN_ID || "42421");
    if (!manager || !isAddress(manager) || expectedChainId !== 42421) {
      return res.status(503).json({ error: "A verified Enugu testnet manager address and chain configuration are required." });
    }

    const client = createPublicClient({ transport: http(rpcUrl) });
    const actualChainId = await client.getChainId();
    if (actualChainId !== expectedChainId) {
      return res.status(503).json({ error: "Configured RPC does not report the expected Asset Chain Enugu testnet chain ID." });
    }

    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status !== "success") {
      return res.status(400).json({ error: "The submitted transaction did not succeed on-chain." });
    }
    const transaction = await client.getTransaction({ hash: txHash as `0x${string}` });
    if (!transaction.to || getAddress(transaction.to) !== getAddress(manager)) {
      return res.status(400).json({ error: "Transaction target does not match the configured market manager." });
    }

    const matching = parseEventLogs({
      abi: marketCreatedAbi,
      logs: receipt.logs.filter((log) => getAddress(log.address) === getAddress(manager)),
      eventName: "MarketCreated",
      strict: true,
    }).find((event) =>
      event.args.marketId?.toString() === marketId &&
      event.args.question === proposal.question &&
      Boolean(event.args.creator) &&
      getAddress(event.args.creator as string) === getAddress(walletAuth.address)
    );
    if (!matching) {
      return res.status(400).json({ error: "Receipt does not contain a matching MarketCreated event for this approved proposal and creator wallet." });
    }

    const stored = await recordOnchainPublication({
      id: proposal.id,
      marketId,
      txHash: txHash.toLowerCase(),
      managerAddress: getAddress(manager),
      chainId: actualChainId,
    });
    if (!stored) {
      return res.status(409).json({ error: "Publication could not be recorded. Confirm the proposal is still approved and has not already been published." });
    }

    return res.status(200).json({
      message: "Verified on-chain publication recorded.",
      proposal: stored,
      publication: {
        marketId,
        txHash: txHash.toLowerCase(),
        managerAddress: getAddress(manager),
        chainId: actualChainId,
        explorerUrl: `${process.env.ASSET_CHAIN_EXPLORER_URL || "https://scan-testnet.assetchain.org"}/tx/${txHash}`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already has a recorded on-chain publication")) {
      return res.status(409).json({ error: error.message });
    }
    return next(error);
  }
});

export default marketsRouter;