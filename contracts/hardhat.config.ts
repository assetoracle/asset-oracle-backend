import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";

const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = privateKey ? [privateKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: {},
    enugu: {
      url: process.env.ASSET_CHAIN_RPC_URL || "https://enugu-rpc.assetchain.org",
      chainId: 42421,
      accounts
    }
  },
  etherscan: {
    apiKey: { enugu: process.env.ASSET_CHAIN_EXPLORER_API_KEY || "" },
    customChains: [{
      network: "enugu",
      chainId: 42421,
      urls: {
        apiURL: process.env.ASSET_CHAIN_EXPLORER_API_URL || "https://scan.assetchain.org/api",
        browserURL: "https://scan.assetchain.org"
      }
    }]
  }
};

export default config;
