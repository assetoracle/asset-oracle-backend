/** Active manager configuration is supplied at runtime after deployment. */
export const CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS =
  process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim() || "";

export const ASSET_CHAIN_TESTNET_ID = 42421;
export const ASSET_CHAIN_TESTNET_RPC_URL = "https://enugu-rpc.assetchain.org";
