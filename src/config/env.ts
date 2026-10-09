const requiredDefaults = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 3000,
  frontendUrl:
    process.env.FRONTEND_URL || "http://localhost:5173",
  assetChainRpcUrl:
    process.env.ASSET_CHAIN_RPC_URL ||
    "https://enugu-rpc.assetchain.org",
  assetChainId: 42421,
  assetChainExplorerUrl:
    process.env.ASSET_CHAIN_EXPLORER_URL ||
    "https://scan-testnet.assetchain.org",
};

export const env = Object.freeze(requiredDefaults);