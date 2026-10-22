import { getAddress, isAddress } from "viem";
import { ASSET_CHAIN_TESTNET_ID, ASSET_CHAIN_TESTNET_RPC_URL } from "../config/assetOracle.js";

/** Approved Asset Chain Enugu testnet USDC address confirmed by the project preflight. */
export const ASSET_CHAIN_TESTNET_USDC_ADDRESS =
  getAddress("0xc33741fddEBeA854d265db6F9707900Efb0211a2");

export type PaidSubmissionTokenConfig = {
  address: `0x${string}`;
  decimals: 6;
};

export type PaidSubmissionTestnetConfig = {
  enabled: boolean;
  chainId: typeof ASSET_CHAIN_TESTNET_ID;
  rpcUrl: string;
  treasuryAddress: `0x${string}` | null;
  tokens: { USDC: PaidSubmissionTokenConfig };
  disabledReasons: string[];
};

/**
 * Testnet-only, fail-closed configuration. USDC is pinned to the project-approved
 * Asset Chain Testnet bridged-USDC address; the payment verifier also checks on-chain decimals.
 */
export function getPaidSubmissionTestnetConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaidSubmissionTestnetConfig {
  const treasuryRaw = env.ASSET_ORACLE_TESTNET_PAID_SUBMISSION_TREASURY_ADDRESS?.trim();
  const treasuryAddress = treasuryRaw && isAddress(treasuryRaw) ? getAddress(treasuryRaw) : null;
  const rpcUrl = env.ASSET_ORACLE_TESTNET_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL;
  const disabledReasons: string[] = [];

  if (env.ASSET_ORACLE_PAID_SUBMISSIONS_TESTNET_ENABLED !== "true") {
    disabledReasons.push("Testnet paid submissions are not explicitly enabled.");
  }
  if (!treasuryAddress) disabledReasons.push("Testnet paid-submission treasury address is not configured.");
  if (!rpcUrl.startsWith("https://")) disabledReasons.push("Testnet RPC must use HTTPS.");

  return {
    enabled: disabledReasons.length === 0,
    chainId: ASSET_CHAIN_TESTNET_ID,
    rpcUrl,
    treasuryAddress,
    tokens: { USDC: { address: ASSET_CHAIN_TESTNET_USDC_ADDRESS, decimals: 6 } },
    disabledReasons,
  };
}
