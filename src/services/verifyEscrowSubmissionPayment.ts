import { createPublicClient, getAddress, http, parseEventLogs, type PublicClient } from "viem";
import type { SubmissionQuote } from "./paidSubmissionQuote.js";

const metadataAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] }] as const;
const transferAbi = [{
  type: "event", name: "Transfer", anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;
const escrowEventAbi = [{
  type: "event", name: "ProposalFeeEscrowed", anonymous: false,
  inputs: [
    { indexed: true, name: "proposalId", type: "bytes32" },
    { indexed: true, name: "payer", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
  ],
}] as const;

export type VerifiedEscrowPayment = {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  confirmations: bigint;
  amountAtomic: string;
  tokenAddress: `0x${string}`;
  sender: `0x${string}`;
  escrowAddress: `0x${string}`;
  proposalIdHash: `0x${string}`;
};

/** Verifies both the escrow's proposal-specific event and the underlying exact USDC transfer. */
export async function verifyEscrowSubmissionPayment(input: {
  rpcUrl: string;
  expectedChainId: number;
  minimumConfirmations: number;
  transactionHash: string;
  authenticatedWallet: string;
  escrowAddress: string;
  expectedProposalIdHash: string;
  quote: SubmissionQuote;
}, clientOverride?: PublicClient): Promise<VerifiedEscrowPayment> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new Error("A valid escrow payment transaction hash is required.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.expectedProposalIdHash)) throw new Error("A valid proposal identifier hash is required.");
  if (!Number.isSafeInteger(input.expectedChainId) || input.expectedChainId <= 0 ||
      !Number.isSafeInteger(input.minimumConfirmations) || input.minimumConfirmations < 1) {
    throw new Error("Payment chain and confirmation policy are not configured safely.");
  }

  const sender = getAddress(input.authenticatedWallet);
  const escrow = getAddress(input.escrowAddress);
  const token = getAddress(input.quote.tokenAddress);
  const proposalIdHash = input.expectedProposalIdHash.toLowerCase() as `0x${string}`;
  const client = clientOverride ?? createPublicClient({ transport: http(input.rpcUrl) });
  if (await client.getChainId() !== input.expectedChainId) throw new Error("Configured RPC is connected to the wrong chain.");
  const [tokenCode, escrowCode] = await Promise.all([client.getCode({ address: token }), client.getCode({ address: escrow })]);
  if (!tokenCode || tokenCode === "0x" || !escrowCode || escrowCode === "0x") throw new Error("USDC token or proposal escrow has no deployed contract code.");
  const decimals = await client.readContract({ address: token, abi: metadataAbi, functionName: "decimals" });
  if (Number(decimals) !== input.quote.tokenDecimals || Number(decimals) !== 6) throw new Error("On-chain USDC decimals do not match the stored six-decimal quote.");

  const hash = input.transactionHash as `0x${string}`;
  const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
  if (receipt.status !== "success") throw new Error("Escrow payment transaction did not succeed.");
  if (transaction.from.toLowerCase() !== sender.toLowerCase()) throw new Error("Escrow payment sender does not match the authenticated wallet.");
  if (!transaction.to || transaction.to.toLowerCase() !== escrow.toLowerCase()) throw new Error("Transaction was not sent to the configured proposal escrow.");

  const latestBlock = await client.getBlockNumber();
  const confirmations = latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(input.minimumConfirmations)) throw new Error("Escrow payment has not reached the required confirmation depth.");

  const escrowEvents = parseEventLogs({
    abi: escrowEventAbi,
    logs: receipt.logs.filter(log => log.address.toLowerCase() === escrow.toLowerCase()),
    eventName: "ProposalFeeEscrowed",
    strict: false,
  });
  const escrowEvent = escrowEvents.find(event =>
    event.args.proposalId?.toLowerCase() === proposalIdHash &&
    event.args.payer?.toLowerCase() === sender.toLowerCase() &&
    event.args.amount?.toString() === input.quote.amountAtomic,
  );
  if (!escrowEvent) throw new Error("No matching proposal-specific escrow event was found.");

  const tokenEvents = parseEventLogs({
    abi: transferAbi,
    logs: receipt.logs.filter(log => log.address.toLowerCase() === token.toLowerCase()),
    eventName: "Transfer",
    strict: false,
  });
  const transfer = tokenEvents.find(event =>
    event.args.from?.toLowerCase() === sender.toLowerCase() &&
    event.args.to?.toLowerCase() === escrow.toLowerCase() &&
    event.args.value?.toString() === input.quote.amountAtomic,
  );
  if (!transfer) throw new Error("No exact USDC transfer from the payer to the proposal escrow was found.");

  return {
    transactionHash: hash,
    blockNumber: receipt.blockNumber,
    confirmations,
    amountAtomic: input.quote.amountAtomic,
    tokenAddress: token,
    sender,
    escrowAddress: escrow,
    proposalIdHash,
  };
}
