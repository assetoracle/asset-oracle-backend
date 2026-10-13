import { getPaidSubmissionMainnetConfig, type PaidSubmissionMainnetConfig, type PaidSubmissionTokenConfig } from "./paidSubmissionConfig.js";
import type { SubmissionToken } from "./paidSubmissionStore.js";

export type CngnRateQuote = {
  /** NGN per USD from a trusted external provider. */
  ngnPerUsd: number;
  /** Provider timestamp in Unix milliseconds. */
  observedAtMs: number;
  /** Provider identifier for audit metadata. */
  source: string;
};

export type SubmissionQuote = {
  network: "MAINNET";
  token: SubmissionToken;
  tokenAddress: `0x${string}`;
  tokenDecimals: number;
  amountAtomic: string;
  usdValue: "10.00";
  issuedAtMs: number;
  expiresAtMs: number;
  rateSource: string;
  ngnPerUsd?: number;
};

const USD_FEE = 10;
const QUOTE_TTL_MS = 2 * 60 * 1000;
const MAX_RATE_AGE_MS = 5 * 60 * 1000;

function atomicUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid quote amount or token decimals.");
  }
  const [whole, fraction = ""] = amount.toFixed(Math.min(decimals, 12)).split(".");
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(padded || "0")).toString();
}

/**
 * Builds a short-lived quote for the $10 submission fee.
 * USDC/USDT use a $1-per-token assumption; cNGN requires a fresh trusted NGN/USD quote.
 * The caller must still verify the eventual ERC-20 transfer against this exact quote.
 */
export function createPaidSubmissionQuote(input: {
  token: SubmissionToken;
  nowMs?: number;
  config?: PaidSubmissionMainnetConfig;
  cngnRate?: CngnRateQuote;
}): SubmissionQuote {
  const nowMs = input.nowMs ?? Date.now();
  const config = input.config ?? getPaidSubmissionMainnetConfig();
  if (!config.enabled) throw new Error("Mainnet paid submissions are disabled or incompletely configured.");
  const tokenConfig: PaidSubmissionTokenConfig | null = config.tokens[input.token];
  if (!tokenConfig) throw new Error("Selected token is not configured for mainnet paid submissions.");

  let tokenAmount = USD_FEE;
  let rateSource = "fixed-usd-stablecoin-assumption";
  let ngnPerUsd: number | undefined;

  if (input.token === "cNGN") {
    const rate = input.cngnRate;
    if (!rate || !Number.isFinite(rate.ngnPerUsd) || rate.ngnPerUsd <= 0 ||
        !Number.isSafeInteger(rate.observedAtMs) || rate.observedAtMs > nowMs ||
        nowMs - rate.observedAtMs > MAX_RATE_AGE_MS ||
        !rate.source.trim()) {
      throw new Error("A fresh trusted cNGN/NGN-per-USD quote is required; cNGN payment quote is unavailable.");
    }
    tokenAmount = USD_FEE * rate.ngnPerUsd;
    rateSource = rate.source.trim();
    ngnPerUsd = rate.ngnPerUsd;
  }

  return {
    network: "MAINNET",
    token: input.token,
    tokenAddress: tokenConfig.address,
    tokenDecimals: tokenConfig.decimals,
    amountAtomic: atomicUnits(tokenAmount, tokenConfig.decimals),
    usdValue: "10.00",
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + QUOTE_TTL_MS,
    rateSource,
    ...(ngnPerUsd === undefined ? {} : { ngnPerUsd }),
  };
}
