import { Router } from "express";
import { createPublicClient, getAddress, http, isAddress } from "viem";
import { z } from "zod";
import { verifyWalletSession } from "../services/walletAuth.js";
import { getHumanValidatorNumber } from "../services/adminAuth.js";
import { CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS, ASSET_CHAIN_TESTNET_RPC_URL } from "../config/assetOracle.js";
import { listValidatorSourceLinks, recordValidatorSourceLink } from "../services/validatorEvidenceStore.js";

const router = Router();
const managerAddress = getAddress(CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS);
const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL;
const managerAbi = [{
  type: "function", name: "hasVoted", stateMutability: "view",
  inputs: [{ name: "marketId", type: "uint256" }, { name: "validator", type: "address" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;
const client = createPublicClient({ transport: http(rpcUrl) });

function sessionToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const addressSchema = z.string().refine(isAddress, "Invalid wallet address");
const marketIdSchema = z.string().regex(/^[1-9][0-9]*$/).max(78);
const urlSchema = z.string().trim().url().max(2048).refine((value) => {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; }
  catch { return false; }
}, "Source must be an HTTP or HTTPS URL");

router.get("/:marketId", async (req, res, next) => {
  try {
    const parsed = z.object({
      marketId: marketIdSchema,
      managerAddress: addressSchema,
    }).safeParse({ marketId: req.params.marketId, managerAddress: req.query.managerAddress });
    if (!parsed.success) return res.status(400).json({ error: "A valid market ID and manager address are required." });
    if (getAddress(parsed.data.managerAddress) !== managerAddress) {
      return res.status(400).json({ error: "Unsupported market manager." });
    }
    const links = await listValidatorSourceLinks(parsed.data.marketId, managerAddress);
    return res.status(200).json({ links });
  } catch (error) { return next(error); }
});

router.post("/", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: addressSchema,
      marketId: marketIdSchema,
      managerAddress: addressSchema,
      outcome: z.number().int().min(1).max(3),
      sourceUrl: urlSchema,
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid market, vote outcome, source URL, transaction hash, and wallet are required." });
    const input = parsed.data;
    if (!await verifyWalletSession(sessionToken(req), input.address)) {
      return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    }
    if (!getHumanValidatorNumber(input.address)) return res.status(403).json({ error: "Only configured validators can record vote evidence." });
    if (getAddress(input.managerAddress) !== managerAddress) return res.status(400).json({ error: "Unsupported market manager." });

    const receipt = await client.getTransactionReceipt({ hash: input.transactionHash as `0x${string}` });
    if (receipt.status !== "success") return res.status(400).json({ error: "The vote transaction did not succeed." });
    const transaction = await client.getTransaction({ hash: input.transactionHash as `0x${string}` });
    if (!transaction.to || getAddress(transaction.to) !== managerAddress || getAddress(transaction.from) !== getAddress(input.address)) {
      return res.status(400).json({ error: "The transaction does not match this validator and market manager." });
    }
    const hasVoted = await client.readContract({
      address: managerAddress, abi: managerAbi, functionName: "hasVoted",
      args: [BigInt(input.marketId), getAddress(input.address)],
    });
    if (!hasVoted) return res.status(409).json({ error: "No confirmed on-chain vote was found for this validator and market." });

    const link = await recordValidatorSourceLink({
      marketId: input.marketId,
      managerAddress,
      validatorAddress: getAddress(input.address),
      outcome: input.outcome,
      sourceUrl: input.sourceUrl,
      transactionHash: input.transactionHash,
    });
    return res.status(201).json({ link });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already been recorded")) {
      return res.status(409).json({ error: error.message });
    }
    return next(error);
  }
});

export default router;
