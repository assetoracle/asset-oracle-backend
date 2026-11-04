/** Set only after the new, reviewed testnet contract has been deployed and verified. */
const newContractVerified = process.env.ASSET_ORACLE_NEW_CONTRACT_VERIFIED === "true";
export const CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS = newContractVerified
  ? process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim() ?? ""
  : "";

export const ASSET_CHAIN_TESTNET_ID = 42421;
export const ASSET_CHAIN_TESTNET_RPC_URL = "https://enugu-rpc.assetchain.org";

/** Validator roster that the new testnet deployment must verify before activation. */
export const HUMAN_VALIDATOR_ADDRESSES = [
  "0x3d3724d20d9d5db5a40819869057b37465a0c67d",
  "0xb94185491c78e7331c5d53e9b0df74970b3c9b8a",
  "0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01",
] as const;

