import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaidSubmissionQuote } from "./paidSubmissionQuote.js";
import type { PaidSubmissionMainnetConfig } from "./paidSubmissionConfig.js";

const config: PaidSubmissionMainnetConfig = {
  enabled: true,
  treasuryAddress: "0x1111111111111111111111111111111111111111",
  tokens: {
    USDC: { address: "0x2222222222222222222222222222222222222222", decimals: 6 },
    USDT: { address: "0x26E490d30e73c36800788DC6d6315946C4BbEa24", decimals: 6 },
    cNGN: { address: "0x3333333333333333333333333333333333333333", decimals: 2 },
  },
  disabledReasons: [],
};

test("creates a $10 USDC/USDT quote in atomic units with expiry", () => {
  const usdc = createPaidSubmissionQuote({ token: "USDC", nowMs: 1_000_000, config });
  assert.equal(usdc.amountAtomic, "10000000");
  assert.equal(usdc.expiresAtMs, 1_120_000);
  const usdt = createPaidSubmissionQuote({ token: "USDT", nowMs: 1_000_000, config });
  assert.equal(usdt.amountAtomic, "10000000");
  assert.equal(usdt.tokenAddress, config.tokens.USDT?.address);
});

test("cNGN quote requires a fresh trusted rate and uses configured decimals", () => {
  assert.throws(() => createPaidSubmissionQuote({ token: "cNGN", nowMs: 1_000_000, config }), /fresh trusted/);
  const quote = createPaidSubmissionQuote({
    token: "cNGN",
    nowMs: 1_000_000,
    config,
    cngnRate: { ngnPerUsd: 1500, observedAtMs: 999_000, source: "trusted-provider" },
  });
  assert.equal(quote.amountAtomic, "1500000");
  assert.equal(quote.ngnPerUsd, 1500);
  assert.equal(quote.rateSource, "trusted-provider");
});

test("rejects stale, future-dated, or invalid cNGN rates", () => {
  assert.throws(() => createPaidSubmissionQuote({
    token: "cNGN", nowMs: 1_000_000, config,
    cngnRate: { ngnPerUsd: 1500, observedAtMs: 600_000, source: "provider" },
  }), /fresh trusted/);
  assert.throws(() => createPaidSubmissionQuote({
    token: "cNGN", nowMs: 1_000_000, config,
    cngnRate: { ngnPerUsd: 1500, observedAtMs: 1_000_001, source: "provider" },
  }), /fresh trusted/);
});
