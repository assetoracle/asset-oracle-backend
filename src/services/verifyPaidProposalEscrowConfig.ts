import { createPublicClient, getAddress, http, type PublicClient } from "viem";

const escrowAbi = [
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "PROPOSAL_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "REVIEWER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const tokenAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;

/** Runtime verification; a configured address alone never enables proposal payments. */
export async function verifyPaidProposalEscrowConfig(input: {
  rpcUrl: string;
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  treasuryAddress: string;
  adminAddress: string;
  reviewerAddress?: string;
}, clientOverride?: PublicClient): Promise<void> {
  const client = clientOverride ?? createPublicClient({ transport: http(input.rpcUrl) });
  if (await client.getChainId() !== input.chainId || input.chainId !== 42421) {
    throw new Error("Paid proposal escrow is not connected to Asset Chain Enugu testnet.");
  }
  const escrowAddress = getAddress(input.escrowAddress);
  const usdcAddress = getAddress(input.usdcAddress);
  const treasuryAddress = getAddress(input.treasuryAddress);
  const adminAddress = getAddress(input.adminAddress);
  const reviewerAddress = getAddress(input.reviewerAddress ?? input.adminAddress);
  const [escrowCode, tokenCode] = await Promise.all([
    client.getCode({ address: escrowAddress }),
    client.getCode({ address: usdcAddress }),
  ]);
  if (!escrowCode || escrowCode === "0x" || !tokenCode || tokenCode === "0x") {
    throw new Error("Configured proposal escrow or approved USDC has no deployed contract code.");
  }
  const [configuredToken, configuredTreasury, fee, decimals, reviewerRole] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "usdc" }),
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "treasury" }),
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "PROPOSAL_FEE" }),
    client.readContract({ address: usdcAddress, abi: tokenAbi, functionName: "decimals" }),
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "REVIEWER_ROLE" }),
  ]);
  if (configuredToken.toLowerCase() !== usdcAddress.toLowerCase()) throw new Error("Escrow is configured with a different USDC token.");
  if (configuredTreasury.toLowerCase() !== treasuryAddress.toLowerCase()) throw new Error("Escrow is configured with a different Treasury address.");
  if (fee !== 10_000_000n || Number(decimals) !== 6) throw new Error("Escrow fee or USDC decimals do not match the exact 10 USDC policy.");
  const [adminIsReviewer, callerIsReviewer] = await Promise.all([
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "hasRole", args: [reviewerRole, adminAddress] }),
    client.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "hasRole", args: [reviewerRole, reviewerAddress] }),
  ]);
  if (!adminIsReviewer) throw new Error("Configured admin wallet does not have the on-chain escrow reviewer role.");
  if (!callerIsReviewer) throw new Error("Connected wallet does not have the on-chain escrow reviewer role.");
}
