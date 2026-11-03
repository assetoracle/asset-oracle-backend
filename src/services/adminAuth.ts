import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
} from "viem";
import { verifyWalletSignature } from "./walletAuth.js";
import {
  ASSET_CHAIN_TESTNET_ID,
  ASSET_CHAIN_TESTNET_RPC_URL,
  CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS,
} from "../config/assetOracle.js";

export type WalletRole = "OWNER" | "VALIDATOR_2" | "VALIDATOR_3" | "MARKET_CREATOR" | "USER";

const managerAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "MARKET_CREATOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "validators", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

function getManagerAddress(): Address {
  const address = CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS;
  if (!address || !isAddress(address)) {
    throw new Error("ASSET_ORACLE_MARKET_MANAGER_ADDRESS must be set to the active manager contract.");
  }
  return getAddress(address);
}

function getClient() {
  const rpcUrl = process.env.ASSET_CHAIN_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL;
  return createPublicClient({ transport: http(rpcUrl) });
}

/** All privileged authorization is derived from the active manager contract. */
export async function isAdminWallet(address: string): Promise<boolean> {
  if (!isAddress(address)) return false;
  const client = getClient();
  const [chainId, owner] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: getManagerAddress(), abi: managerAbi, functionName: "owner" }),
  ]);
  if (chainId !== ASSET_CHAIN_TESTNET_ID) {
    throw new Error(`Asset Oracle authorization RPC returned unexpected chain ID ${chainId}.`);
  }
  return getAddress(owner) === getAddress(address);
}

export async function isMarketCreatorWallet(address: string): Promise<boolean> {
  if (!isAddress(address)) return false;
  const client = getClient();
  const [chainId, owner, role] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: getManagerAddress(), abi: managerAbi, functionName: "owner" }),
    client.readContract({ address: getManagerAddress(), abi: managerAbi, functionName: "MARKET_CREATOR_ROLE" }),
  ]);
  if (chainId !== ASSET_CHAIN_TESTNET_ID) {
    throw new Error(`Asset Oracle authorization RPC returned unexpected chain ID ${chainId}.`);
  }
  if (getAddress(owner) === getAddress(address)) return true;
  return client.readContract({
    address: getManagerAddress(),
    abi: managerAbi,
    functionName: "hasRole",
    args: [role, getAddress(address)],
  });
}

/** Returns the current global validator slot. Market actions must use the market snapshot. */
export async function getHumanValidatorNumber(address: string): Promise<1 | 2 | 3 | null> {
  if (!isAddress(address)) return null;
  const client = getClient();
  const manager = getManagerAddress();
  const [chainId, roster] = await Promise.all([
    client.getChainId(),
    Promise.all([0n, 1n, 2n].map((index) => client.readContract({
      address: manager,
      abi: managerAbi,
      functionName: "validators",
      args: [index],
    }))),
  ]);
  if (chainId !== ASSET_CHAIN_TESTNET_ID) {
    throw new Error(`Asset Oracle authorization RPC returned unexpected chain ID ${chainId}.`);
  }
  const normalized = getAddress(address);
  const index = roster.findIndex((validator) => getAddress(validator) === normalized);
  return index < 0 ? null : (index + 1) as 1 | 2 | 3;
}

export async function isHumanValidator(address: string): Promise<boolean> {
  return (await getHumanValidatorNumber(address)) !== null;
}

export async function getWalletRole(address: string): Promise<WalletRole> {
  if (!isAddress(address)) return "USER";
  if (await isAdminWallet(address)) return "OWNER";
  const validatorNumber = await getHumanValidatorNumber(address);
  if (validatorNumber === 2) return "VALIDATOR_2";
  if (validatorNumber === 3) return "VALIDATOR_3";
  if (await isMarketCreatorWallet(address)) return "MARKET_CREATOR";
  return "USER";
}

export async function getWalletRoleDetails(address: string) {
  const isOwner = await isAdminWallet(address);
  const validatorNumber = await getHumanValidatorNumber(address);
  const isCreator = await isMarketCreatorWallet(address);
  return {
    role: isOwner ? "OWNER" : validatorNumber === 2 ? "VALIDATOR_2" : validatorNumber === 3 ? "VALIDATOR_3" : isCreator ? "MARKET_CREATOR" : "USER",
    isOwner,
    humanValidator: validatorNumber !== null,
    validatorNumber,
    permissions: {
      createMarketProposal: isCreator,
      submitPaidMarketProposal: !isCreator,
      viewOwnProposals: true,
      reviewAllProposals: isOwner || isCreator,
      approveOrRejectProposals: isOwner || isCreator,
      isHumanValidator: validatorNumber !== null,
      validatorNumber,
    },
  };
}

export async function verifyAdminWallet(
  address: string,
  signature: `0x${string}`,
  message: string,
): Promise<boolean> {
  if (!(await isAdminWallet(address))) return false;
  return verifyWalletSignature(address, signature, message);
}
