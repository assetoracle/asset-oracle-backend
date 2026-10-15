/** Canonical Asset Oracle deployment used by the backend runtime. */
export const CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS =
  "0x5fc327f55cf533ed5d05337f835be37ff1e0db1f" as const;

export const ASSET_CHAIN_TESTNET_ID = 42421;
export const ASSET_CHAIN_TESTNET_RPC_URL = "https://enugu-rpc.assetchain.org";

/** Fixed public roster configured on the current manager contract. */
export const HUMAN_VALIDATOR_ADDRESSES = [
  "0x3d3724d20d9d5db5a40819869057b37465a0c67d",
  "0xb94185491c78e7331c5d53e9b0df74970b3c9b8a",
  "0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01",
] as const;
