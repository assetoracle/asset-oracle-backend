import assert from "node:assert/strict";
import { test } from "node:test";
import { getPaidSubmissionTestnetConfig } from "./paidSubmissionConfig.js";

const validEnv: NodeJS.ProcessEnv = {
  ASSET_ORACLE_PAID_SUBMISSIONS_TESTNET_ENABLED: "true",
  ASSET_ORACLE_TESTNET_PAID_SUBMISSION_TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
  ASSET_ORACLE_TESTNET_USDC_ADDRESS: "0x2222222222222222222222222222222222222222",
  ASSET_ORACLE_TESTNET_USDC_DECIMALS: "6",
  ASSET_ORACLE_TESTNET_RPC_URL: "https://enugu-rpc.assetchain.org",
};

test("testnet paid submissions fail closed without explicit enablement and verified addresses", () => {
  const config = getPaidSubmissionTestnetConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.chainId, 42421);
  assert.equal(config.treasuryAddress, null);
  assert.equal(config.tokens.USDC, null);
  assert.ok(config.disabledReasons.length >= 3);
});

test("testnet config accepts only configured USDC with six decimals", () => {
  const config = getPaidSubmissionTestnetConfig(validEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.chainId, 42421);
  assert.equal(config.tokens.USDC?.address, validEnv.ASSET_ORACLE_TESTNET_USDC_ADDRESS);
  assert.equal(config.tokens.USDC?.decimals, 6);
});

test("invalid USDC decimals and missing treasury fail closed", () => {
  const invalidDecimals = getPaidSubmissionTestnetConfig({
    ...validEnv,
    ASSET_ORACLE_TESTNET_USDC_DECIMALS: "18",
  });
  assert.equal(invalidDecimals.enabled, false);
  assert.equal(invalidDecimals.tokens.USDC, null);

  const missingTreasury = getPaidSubmissionTestnetConfig({
    ...validEnv,
    ASSET_ORACLE_TESTNET_PAID_SUBMISSION_TREASURY_ADDRESS: "",
  });
  assert.equal(missingTreasury.enabled, false);
  assert.equal(missingTreasury.treasuryAddress, null);
});

test("mainnet activation variables cannot enable testnet payments by themselves", () => {
  const config = getPaidSubmissionTestnetConfig({
    ASSET_ORACLE_PAID_SUBMISSIONS_MAINNET_ENABLED: "true",
    ASSET_ORACLE_MAINNET_USDC_ADDRESS: "0x2222222222222222222222222222222222222222",
    ASSET_ORACLE_MAINNET_USDC_DECIMALS: "6",
  });
  assert.equal(config.enabled, false);
});
