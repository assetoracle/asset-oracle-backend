import { getAddress, isAddress } from "viem";
import { ASSET_CHAIN_TESTNET_ID, ASSET_CHAIN_TESTNET_RPC_URL } from "../config/assetOracle.js";

export type PaidSubmissionTokenConfig = {
  address: `0x${string}`;
  decimals: number;
};

export type PaidSubmissionTestnetConfig = {
  enabled: boolean;
  chainId: typeof ASSET_CHAIN_TESTNET_ID;
  rpcUrl: string;
  treasuryAddress: `0x${string}` | null;
  tokens: { USDC: PaidSubmissionTokenConfig | null };
  disabledReasons: string[];
};

function readUsdc(env: NodeJS.ProcessEnv): PaidSubmissionTokenConfig | null {
  const address = env.ASSET_ORACLE_TESTNET_USDC_ADDRESS?.trim();
  const decimalsRaw = env.ASSET_ORACLE_TESTNET_USDC_DECIMALS?.trim();
  if (!address || !isAddress(address) || decimalsRaw !== "6") return null;
  return { address: getAddress(address), decimals: 6 };
}

/**
 * Testnet-only, fail-closed configuration. No mainnet configuration is read here.
 * The USDC contract and treasury must be independently verified before enabling.
 */
export function getPaidSubmissionTestnetConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaidSubmissionTestnetConfig {
  const usdc = readUsdc(env);
  const treasuryRaw = env.ASSET_ORACLE_TESTNET_PAID_SUBMISSION_TREASURY_ADDRESS?.trim();
  const treasuryAddress = treasuryRaw && isAddress(treasuryRaw) ? getAddress(treasuryRaw) : null;
  const rpcUrl = env.ASSET_ORACLE_TESTNET_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL;
  const disabledReasons: string[] = [];

  if (env.ASSET_ORACLE_PAID_SUBMISSIONS_TESTNET_ENABLED !== "true") {
    disabledReasons.push("Testnet paid submissions are not explicitly enabled.");
  }
  if (!usdc) disabledReasons.push("Verified testnet USDC address and 6 decimals are not configured.");
  if (!treasuryAddress) disabledReasons.push("Testnet paid-submission treasury address is not configured.");
  if (!rpcUrl.startsWith("https://")) disabledReasons.push("Testnet RPC must use HTTPS.");

  return {
    enabled: disabledReasons.length === 0,
    chainId: ASSET_CHAIN_TESTNET_ID,
    rpcUrl,
    treasuryAddress,
    tokens: { USDC: usdc },
    disabledReasons,
  };
}
