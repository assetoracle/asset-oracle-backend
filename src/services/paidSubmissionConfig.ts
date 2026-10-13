import { getAddress, isAddress } from "viem";

export type PaidSubmissionTokenConfig = {
  address: `0x${string}`;
  decimals: number;
};

export type PaidSubmissionMainnetConfig = {
  enabled: boolean;
  treasuryAddress: `0x${string}` | null;
  tokens: {
    USDC: PaidSubmissionTokenConfig | null;
    USDT: PaidSubmissionTokenConfig | null;
    cNGN: PaidSubmissionTokenConfig | null;
  };
  disabledReasons: string[];
};

function readToken(
  env: NodeJS.ProcessEnv,
  name: "USDC" | "USDT" | "CNGN",
): PaidSubmissionTokenConfig | null {
  const address = env[`ASSET_ORACLE_MAINNET_${name}_ADDRESS`]?.trim();
  const decimalsRaw = env[`ASSET_ORACLE_MAINNET_${name}_DECIMALS`]?.trim();
  if (!address || !isAddress(address) || !decimalsRaw || !/^(0|[1-9][0-9]*)$/.test(decimalsRaw)) {
    return null;
  }
  const decimals = Number(decimalsRaw);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return { address: getAddress(address), decimals };
}

/**
 * Fail-closed configuration reader. This does not verify token identity on-chain;
 * configured addresses and decimals must be independently verified before activation.
 */
export function getPaidSubmissionMainnetConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaidSubmissionMainnetConfig {
  const usdc = readToken(env, "USDC");
  const usdt = readToken(env, "USDT");
  const cngn = readToken(env, "CNGN");
  const treasuryRaw = env.ASSET_ORACLE_PAID_SUBMISSION_TREASURY_ADDRESS?.trim();
  const treasuryAddress = treasuryRaw && isAddress(treasuryRaw) ? getAddress(treasuryRaw) : null;
  const disabledReasons: string[] = [];

  if (env.ASSET_ORACLE_PAID_SUBMISSIONS_MAINNET_ENABLED !== "true") {
    disabledReasons.push("Mainnet paid submissions are not explicitly enabled.");
  }
  if (!usdc) disabledReasons.push("Mainnet USDC address/decimals are not configured.");
  if (!usdt) disabledReasons.push("Mainnet USDT address/decimals are not configured.");
  if (!cngn) disabledReasons.push("Mainnet cNGN address/decimals are not configured.");
  if (!treasuryAddress) disabledReasons.push("Paid-submission treasury address is not configured.");

  return {
    enabled: disabledReasons.length === 0,
    treasuryAddress,
    tokens: { USDC: usdc, USDT: usdt, cNGN: cngn },
    disabledReasons,
  };
}
