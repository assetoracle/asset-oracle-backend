import { Router } from "express";
import { isAddress } from "viem";
import { z } from "zod";
import { marketProposalSchema } from "../services/marketValidation.js";
import { verifyWalletSignature } from "../services/walletAuth.js";
import { getPaidSubmissionTestnetConfig } from "../services/paidSubmissionConfig.js";
import { isMarketCreatorWallet } from "../services/adminAuth.js";
import { createPaidSubmissionIntent, getPaidSubmissionPaymentContext } from "../services/paidSubmissionIntentStore.js";
import { getActiveSubmissionQuote } from "../services/submissionQuoteStore.js";
import { verifyEscrowSubmissionPayment } from "../services/verifyEscrowSubmissionPayment.js";
import { verifyPaidProposalEscrowConfig } from "../services/verifyPaidProposalEscrowConfig.js";
import {
  recordConfirmedSubmissionPayment,
} from "../services/paidSubmissionStore.js";
import { isAdminWallet } from "../services/adminAuth.js";
import { verifyWalletSession } from "../services/walletAuth.js";


const router = Router();
const walletAuthSchema = z.object({
  address: z.string().refine(isAddress),
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

router.post("/intent", async (req, res, next) => {
  try {
    const parsed = z.object({
      proposal: marketProposalSchema,
      quoteId: z.string().uuid(),
      walletAuth: walletAuthSchema,
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid proposal, quote ID, and wallet authentication are required." });

    const { proposal, quoteId, walletAuth } = parsed.data;
    if (!await verifyWalletSignature(walletAuth.address, walletAuth.signature as `0x${string}`, walletAuth.message)) {
      return res.status(401).json({ error: "Wallet verification failed. Request a new nonce and sign again." });
    }
    if (isMarketCreatorWallet(walletAuth.address) || isAdminWallet(walletAuth.address)) {
      return res.status(403).json({ error: "Market makers submit proposals for free and cannot create paid submission intents." });
    }

    const config = getPaidSubmissionTestnetConfig();
    if (!config.enabled || !config.treasuryAddress || !config.escrowAddress) {
      return res.status(503).json({ error: "Testnet USDC paid submissions are disabled until the testnet USDC contract and treasury are verified.", network: "TESTNET", chainId: config.chainId, disabledReasons: config.disabledReasons });
    }
    const adminAddress = process.env.ADMIN_WALLET_ADDRESS?.trim();
    if (!adminAddress || !isAddress(adminAddress)) return res.status(503).json({ error: "Configured admin wallet is required to verify the proposal escrow." });
    await verifyPaidProposalEscrowConfig({
      rpcUrl: config.rpcUrl, chainId: config.chainId, escrowAddress: config.escrowAddress!,
      usdcAddress: config.tokens.USDC.address, treasuryAddress: config.treasuryAddress!, adminAddress,
    });
    const quote = await getActiveSubmissionQuote({ quoteId, walletAddress: walletAuth.address });
    if (!quote) return res.status(409).json({ error: "Quote is missing, expired, already used, or belongs to another wallet. Request a new quote." });
    const tokenConfig = config.tokens[quote.token];
    if (!tokenConfig || tokenConfig.address.toLowerCase() !== quote.tokenAddress.toLowerCase() ||
        tokenConfig.decimals !== quote.tokenDecimals) {
      return res.status(409).json({ error: "Quote token configuration has changed. Request a new quote." });
    }
    const result = await createPaidSubmissionIntent({
      proposal,
      walletAddress: walletAuth.address,
      quoteId,
      escrowAddress: config.escrowAddress,
    });
    return res.status(201).json({
      message: "Payment intent created. The market remains pending review and is not published.",
      submissionId: result.submissionId,
      proposal: result.proposal,
      payment: result.payment,
    });
  } catch (error) {
    if (error instanceof Error && /Quote is missing|Quote could not be reserved/.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    return next(error);
  }
});

router.post("/verify-payment", async (req, res, next) => {
  try {
    const parsed = z.object({
      submissionId: z.string().uuid(),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      walletAuth: walletAuthSchema,
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid submission ID, transaction hash, and wallet authentication are required." });

    const { submissionId, transactionHash, walletAuth } = parsed.data;
    if (!await verifyWalletSignature(walletAuth.address, walletAuth.signature as `0x${string}`, walletAuth.message)) {
      return res.status(401).json({ error: "Wallet verification failed. Request a new nonce and sign again." });
    }
    if (isMarketCreatorWallet(walletAuth.address) || isAdminWallet(walletAuth.address)) {
      return res.status(403).json({ error: "Market makers do not pay proposal fees." });
    }
    const context = await getPaidSubmissionPaymentContext({ submissionId, walletAddress: walletAuth.address });
    if (!context) return res.status(404).json({ error: "Paid submission not found for this wallet." });
    if (context.status === "PAID_PENDING_REVIEW" && context.paymentTxHash?.toLowerCase() === transactionHash.toLowerCase()) {
      return res.status(200).json({ status: context.status, message: "Payment was already verified." });
    }
    if (context.status !== "AWAITING_PAYMENT") {
      return res.status(409).json({ error: "This submission is not awaiting payment.", status: context.status });
    }

    const config = getPaidSubmissionTestnetConfig();
    const rpcUrl = config.rpcUrl;
    const chainId = config.chainId;
    const confirmations = Number(process.env.ASSET_ORACLE_TESTNET_PAYMENT_CONFIRMATIONS || "2");
    if (!config.enabled || !config.treasuryAddress || !config.escrowAddress || !Number.isSafeInteger(confirmations) || confirmations < 1) {
      return res.status(503).json({ error: "Testnet payment verification is disabled until USDC, treasury, RPC, and confirmation policy are verified.", network: "TESTNET", chainId });
    }
    const adminAddress = process.env.ADMIN_WALLET_ADDRESS?.trim();
    if (!adminAddress || !isAddress(adminAddress)) return res.status(503).json({ error: "Configured admin wallet is required to verify the proposal escrow." });
    await verifyPaidProposalEscrowConfig({
      rpcUrl, chainId, escrowAddress: config.escrowAddress!,
      usdcAddress: config.tokens.USDC.address, treasuryAddress: config.treasuryAddress!, adminAddress,
    });
    const tokenConfig = config.tokens[context.quote.token];
    if (!tokenConfig || tokenConfig.address.toLowerCase() !== context.quote.tokenAddress.toLowerCase() ||
        tokenConfig.decimals !== context.quote.tokenDecimals) {
      return res.status(503).json({ error: "Stored quote does not match the current verified token configuration." });
    }

    const verified = await verifyEscrowSubmissionPayment({
      rpcUrl,
      expectedChainId: chainId,
      minimumConfirmations: confirmations,
      transactionHash,
      authenticatedWallet: walletAuth.address,
      escrowAddress: config.escrowAddress,
      expectedProposalIdHash: context.proposalIdHash,
      quote: context.quote,
    });
    if (verified.amountAtomic !== context.quote.amountAtomic ||
        verified.tokenAddress.toLowerCase() !== tokenConfig.address.toLowerCase()) {
      return res.status(400).json({ error: "Verified transfer does not match the stored payment quote." });
    }
    await recordConfirmedSubmissionPayment({ id: submissionId, paymentTxHash: verified.transactionHash });
    return res.status(200).json({ status: "PAID_PENDING_REVIEW", message: "Payment verified. The market is now awaiting admin review; it has not been published." });
  } catch (error) {
    if (error instanceof Error && /wrong chain|did not succeed|sender does not match|not sent to|confirmation depth|exact USDC transfer|escrow event|not awaiting payment|already recorded|proposal identifier/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    return next(error);
  }
});

export default router;
