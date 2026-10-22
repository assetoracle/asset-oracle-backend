import { createPublicClient, getAddress, http, parseEventLogs, type PublicClient } from "viem";

const transferAbi = [{
  type: "event", name: "Transfer", anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

export type VerifiedTokenRefund = {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  confirmations: bigint;
  amountAtomic: string;
  tokenAddress: `0x${string}`;
  sender: `0x${string}`;
  recipient: `0x${string}`;
};

/** Read-only refund verification; never signs or broadcasts a treasury transaction. */
export async function verifyErc20SubmissionRefund(input: {
  rpcUrl: string;
  expectedChainId: number;
  minimumConfirmations: number;
  transactionHash: string;
  treasuryAddress: string;
  recipientWallet: string;
  tokenAddress: string;
  amountAtomic: string;
}, clientOverride?: PublicClient): Promise<VerifiedTokenRefund> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new Error("A valid refund transaction hash is required.");
  if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) throw new Error("Expected refund amount is invalid.");
  if (!Number.isSafeInteger(input.expectedChainId) || input.expectedChainId <= 0 ||
      !Number.isSafeInteger(input.minimumConfirmations) || input.minimumConfirmations < 1) {
    throw new Error("Refund chain and confirmation policy are not configured safely.");
  }

  const treasury = getAddress(input.treasuryAddress);
  const recipient = getAddress(input.recipientWallet);
  const token = getAddress(input.tokenAddress);
  const client = clientOverride ?? createPublicClient({ transport: http(input.rpcUrl) });
  if (await client.getChainId() !== input.expectedChainId) throw new Error("Configured RPC is connected to the wrong chain.");

  const hash = input.transactionHash as `0x${string}`;
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new Error("Refund transaction did not succeed.");
  if (transaction.from.toLowerCase() !== treasury.toLowerCase()) throw new Error("Refund sender does not match the configured treasury.");
  if (!transaction.to || transaction.to.toLowerCase() !== token.toLowerCase()) throw new Error("Refund transaction was not sent to the approved USDC contract.");

  const latestBlock = await client.getBlockNumber();
  const confirmations = latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(input.minimumConfirmations)) throw new Error("Refund has not reached the required confirmation depth.");

  const events = parseEventLogs({
    abi: transferAbi,
    logs: receipt.logs.filter(log => log.address.toLowerCase() === token.toLowerCase()),
    eventName: "Transfer",
    strict: false,
  });
  const match = events.find(event =>
    event.args.from?.toLowerCase() === treasury.toLowerCase() &&
    event.args.to?.toLowerCase() === recipient.toLowerCase() &&
    event.args.value?.toString() === input.amountAtomic,
  );
  if (!match) throw new Error("No exact USDC Transfer event from treasury to the submitting wallet was found.");

  return {
    transactionHash: hash,
    blockNumber: receipt.blockNumber,
    confirmations,
    amountAtomic: input.amountAtomic,
    tokenAddress: token,
    sender: treasury,
    recipient,
  };
}
