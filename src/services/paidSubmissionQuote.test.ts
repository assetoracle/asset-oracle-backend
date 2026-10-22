import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaidSubmissionQuote } from "./paidSubmissionQuote.js";
import type { PaidSubmissionTestnetConfig } from "./paidSubmissionConfig.js";

const config: PaidSubmissionTestnetConfig = {
  enabled: true,
  chainId: 42421,
  rpcUrl: "https://enugu-rpc.assetchain.org",
  treasuryAddress: "0x1111111111111111111111111111111111111111",
  tokens: { USDC: { address: "0x2222222222222222222222222222222222222222", decimals: 6 } },
  disabledReasons: [],
};

test("creates an exact 10 USDC testnet quote in atomic units with expiry", () => {
  const quote = createPaidSubmissionQuote({ token: "USDC", nowMs: 1_000_000, config });
  assert.equal(quote.network, "TESTNET");
  assert.equal(quote.token, "USDC");
  assert.equal(quote.amountAtomic, "10000000");
  assert.equal(quote.tokenDecimals, 6);
  assert.equal(quote.expiresAtMs, 1_120_000);
  assert.equal(quote.tokenAddress, config.tokens.USDC?.address);
});

test("rejects a quote when testnet payment configuration is disabled", () => {
  assert.throws(() => createPaidSubmissionQuote({
    token: "USDC", nowMs: 1_000_000, config: { ...config, enabled: false },
  }), /disabled/);
});

test("the quote API's token type cannot represent USDT or cNGN", () => {
  assert.throws(() => createPaidSubmissionQuote({
    token: "USDC", nowMs: 1_000_000, config: { ...config, tokens: { USDC: null } },
  }), /USDC/);
});
