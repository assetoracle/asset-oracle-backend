import { createPublicClient, getAddress, http, parseEventLogs, type PublicClient } from "viem";
import type { SubmissionQuote } from "./paidSubmissionQuote.js";

const erc20MetadataAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] }] as const;

const transferAbi = [{
  type: "event", name: "Transfer", anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

export type VerifiedTokenPayment = {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  confirmations: bigint;
  amountAtomic: string;
  tokenAddress: `0x${string}`;
  sender: `0x${string}`;
  recipient: `0x${string}`;
};

/** Read-only receipt verification. It never sends a transaction or writes to storage. */
export async function verifyErc20SubmissionPayment(input: {
  rpcUrl: string;
  expectedChainId: number;
  minimumConfirmations: number;
  transactionHash: string;
  authenticatedWallet: string;
  treasuryAddress: string;
  quote: SubmissionQuote;
  nowMs?: number;
}, clientOverride?: PublicClient): Promise<VerifiedTokenPayment> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new Error("A valid payment transaction hash is required.");
  if (!Number.isSafeInteger(input.expectedChainId) || input.expectedChainId <= 0 ||
      !Number.isSafeInteger(input.minimumConfirmations) || input.minimumConfirmations < 1) {
    throw new Error("Payment chain and confirmation policy are not configured safely.");
  }

  const sender = getAddress(input.authenticatedWallet);
  const treasury = getAddress(input.treasuryAddress);
  const token = getAddress(input.quote.tokenAddress);
  const client = clientOverride ?? createPublicClient({ transport: http(input.rpcUrl) });
  if (await client.getChainId() !== input.expectedChainId) throw new Error("Configured RPC is connected to the wrong chain.");
  const onchainDecimals = await client.readContract({ address: token, abi: erc20MetadataAbi, functionName: "decimals" });
  if (Number(onchainDecimals) !== input.quote.tokenDecimals) throw new Error("On-chain token decimals do not match the stored quote.");

  const hash = input.transactionHash as `0x${string}`;
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new Error("Payment transaction did not succeed.");
  if (transaction.from.toLowerCase() !== sender.toLowerCase()) throw new Error("Payment sender does not match the authenticated wallet.");
  if (!transaction.to || transaction.to.toLowerCase() !== token.toLowerCase()) throw new Error("Transaction was not sent to the selected stablecoin contract.");

  const paymentBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (Number(paymentBlock.timestamp) * 1000 > input.quote.expiresAtMs) throw new Error("Payment was mined after the quote expired; request a new quote.");

  const latestBlock = await client.getBlockNumber();
  const confirmations = latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(input.minimumConfirmations)) throw new Error("Payment has not reached the required confirmation depth.");

  const events = parseEventLogs({
    abi: transferAbi,
    logs: receipt.logs.filter(log => log.address.toLowerCase() === token.toLowerCase()),
    eventName: "Transfer",
    strict: false,
  });
  const match = events.find(event =>
    event.args.from?.toLowerCase() === sender.toLowerCase() &&
    event.args.to?.toLowerCase() === treasury.toLowerCase() &&
    event.args.value?.toString() === input.quote.amountAtomic,
  );
  if (!match) throw new Error("No exact Transfer event from the payer to the configured treasury was found.");

  return {
    transactionHash: hash,
    blockNumber: receipt.blockNumber,
    confirmations,
    amountAtomic: input.quote.amountAtomic,
    tokenAddress: token,
    sender,
    recipient: treasury,
  };
}
