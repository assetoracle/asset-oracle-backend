import assert from "node:assert/strict";
import { test } from "node:test";
import { getPaidSubmissionMainnetConfig } from "./paidSubmissionConfig.js";

const validEnv: NodeJS.ProcessEnv = {
  ASSET_ORACLE_PAID_SUBMISSIONS_MAINNET_ENABLED: "true",
  ASSET_ORACLE_PAID_SUBMISSION_TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
  ASSET_ORACLE_MAINNET_USDC_ADDRESS: "0x2222222222222222222222222222222222222222",
  ASSET_ORACLE_MAINNET_USDC_DECIMALS: "6",
  ASSET_ORACLE_MAINNET_USDT_ADDRESS: "0x26E490d30e73c36800788DC6d6315946C4BbEa24",
  ASSET_ORACLE_MAINNET_USDT_DECIMALS: "6",
  ASSET_ORACLE_MAINNET_CNGN_ADDRESS: "0x3333333333333333333333333333333333333333",
  ASSET_ORACLE_MAINNET_CNGN_DECIMALS: "2",
};

test("mainnet paid submissions remain disabled unless every required setting is present", () => {
  const config = getPaidSubmissionMainnetConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.treasuryAddress, null);
  assert.equal(config.tokens.USDT, null);
  assert.ok(config.disabledReasons.length >= 5);
});

test("mainnet config reads the corrected USDT address and explicit decimals", () => {
  const config = getPaidSubmissionMainnetConfig(validEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.tokens.USDT?.address, "0x26E490D30E73c36800788Dc6D6315946C4bBeA24");
  assert.equal(config.tokens.USDT?.decimals, 6);
});

test("invalid token decimals or missing treasury fail closed", () => {
  const invalidDecimals = getPaidSubmissionMainnetConfig({
    ...validEnv,
    ASSET_ORACLE_MAINNET_USDT_DECIMALS: "999",
  });
  assert.equal(invalidDecimals.enabled, false);
  assert.equal(invalidDecimals.tokens.USDT, null);

  const missingTreasury = getPaidSubmissionMainnetConfig({
    ...validEnv,
    ASSET_ORACLE_PAID_SUBMISSION_TREASURY_ADDRESS: "",
  });
  assert.equal(missingTreasury.enabled, false);
  assert.equal(missingTreasury.treasuryAddress, null);
});
