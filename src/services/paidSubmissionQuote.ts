import { getPaidSubmissionTestnetConfig, type PaidSubmissionTestnetConfig, type PaidSubmissionTokenConfig } from "./paidSubmissionConfig.js";

export type SubmissionQuote = {
  network: "TESTNET";
  token: "USDC";
  tokenAddress: `0x${string}`;
  tokenDecimals: number;
  amountAtomic: string;
  usdValue: "10.00";
  issuedAtMs: number;
  expiresAtMs: number;
  rateSource: string;
};

const QUOTE_TTL_MS = 2 * 60 * 1000;

/** Creates an exact 10 USDC quote (10 * 10^6 atomic units) for Asset Chain testnet only. */
export function createPaidSubmissionQuote(input: {
  token: "USDC";
  nowMs?: number;
  config?: PaidSubmissionTestnetConfig;
}): SubmissionQuote {
  const nowMs = input.nowMs ?? Date.now();
  const config = input.config ?? getPaidSubmissionTestnetConfig();
  if (!config.enabled) throw new Error("Testnet paid submissions are disabled or incompletely configured.");
  const tokenConfig: PaidSubmissionTokenConfig | null = config.tokens.USDC;
  if (!tokenConfig || tokenConfig.decimals !== 6) {
    throw new Error("Verified testnet USDC with 6 decimals is required.");
  }

  return {
    network: "TESTNET",
    token: "USDC",
    tokenAddress: tokenConfig.address,
    tokenDecimals: 6,
    amountAtomic: "10000000",
    usdValue: "10.00",
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + QUOTE_TTL_MS,
    rateSource: "fixed-usdc-testnet-fee",
  };
}
