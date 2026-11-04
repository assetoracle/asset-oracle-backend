import { createPublicClient, getAddress, http, parseEventLogs, type PublicClient } from "viem";

const decisionAbi = [
  { type: "event", name: "ProposalFeeReleased", anonymous: false, inputs: [
    { indexed: true, name: "proposalId", type: "bytes32" },
    { indexed: true, name: "payer", type: "address" },
    { indexed: true, name: "treasury", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
    { indexed: false, name: "reviewer", type: "address" },
  ]},
  { type: "event", name: "ProposalFeeRefunded", anonymous: false, inputs: [
    { indexed: true, name: "proposalId", type: "bytes32" },
    { indexed: true, name: "payer", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
    { indexed: false, name: "reviewer", type: "address" },
  ]},
  { type: "function", name: "proposalPayments", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [
    { name: "payer", type: "address" }, { name: "decision", type: "uint8" },
  ]},
] as const;

export async function verifyEscrowDecision(input: {
  rpcUrl: string;
  expectedChainId: number;
  minimumConfirmations: number;
  transactionHash: string;
  authenticatedReviewer: string;
  escrowAddress: string;
  proposalIdHash: string;
  expectedPayer: string;
  expectedTreasury: string;
  decision: "APPROVED" | "REJECTED";
}, clientOverride?: PublicClient): Promise<{ transactionHash: `0x${string}`; confirmations: bigint }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(input.proposalIdHash)) {
    throw new Error("A valid escrow decision transaction and proposal identifier are required.");
  }
  const client = clientOverride ?? createPublicClient({ transport: http(input.rpcUrl) });
  if (await client.getChainId() !== input.expectedChainId) throw new Error("Configured RPC is connected to the wrong chain.");
  const escrow = getAddress(input.escrowAddress);
  const reviewer = getAddress(input.authenticatedReviewer);
  const expectedPayer = getAddress(input.expectedPayer);
  const expectedTreasury = getAddress(input.expectedTreasury);
  const proposalId = input.proposalIdHash.toLowerCase() as `0x${string}`;
  const hash = input.transactionHash as `0x${string}`;
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  if (receipt.status !== "success") throw new Error("Escrow decision transaction did not succeed.");
  if (!transaction.to || transaction.to.toLowerCase() !== escrow.toLowerCase()) throw new Error("Decision transaction was not sent to the configured escrow.");
  if (transaction.from.toLowerCase() !== reviewer.toLowerCase()) throw new Error("Decision transaction sender does not match the authenticated reviewer.");
  const latest = await client.getBlockNumber();
  const confirmations = latest >= receipt.blockNumber ? latest - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(input.minimumConfirmations)) throw new Error("Escrow decision has not reached the required confirmation depth.");

  const eventName = input.decision === "APPROVED" ? "ProposalFeeReleased" : "ProposalFeeRefunded";
  const events = parseEventLogs({
    abi: decisionAbi,
    logs: receipt.logs.filter(log => log.address.toLowerCase() === escrow.toLowerCase()),
    eventName,
    strict: false,
  });
  const matching = events.find(event =>
    event.args.proposalId?.toLowerCase() === proposalId &&
    event.args.reviewer?.toLowerCase() === reviewer.toLowerCase() &&
    event.args.payer?.toLowerCase() === expectedPayer.toLowerCase() &&
    (input.decision === "REJECTED" || (event.args as { treasury?: string }).treasury?.toLowerCase() === expectedTreasury.toLowerCase()) &&
    event.args.amount === 10_000_000n,
  );
  if (!matching) throw new Error("No matching escrow approval/release or rejection/refund event was found.");

  const state = await client.readContract({
    address: escrow,
    abi: decisionAbi,
    functionName: "proposalPayments",
    args: [proposalId],
  });
  const expectedState = input.decision === "APPROVED" ? 2 : 3;
  if (Number(state[1]) !== expectedState) throw new Error("Escrow on-chain decision state does not match the requested admin decision.");
  return { transactionHash: hash, confirmations };
}
