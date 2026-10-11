import "dotenv/config";
import { ethers } from "hardhat";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

function decimals(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1 || value > 18) throw new Error(`Invalid token decimals: ${name}`);
  return value;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer configured. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");

  const treasury = ethers.getAddress(required("TREASURY_ADDRESS"));
  const validatorPool = ethers.getAddress(required("VALIDATOR_REWARD_POOL_ADDRESS"));
  const resolver = ethers.getAddress(required("ORACLE_RESOLVER_ADDRESS"));

  const tokenConfigs = [
    { kind: 0, address: ethers.getAddress(required("CNGN_TOKEN_ADDRESS")), decimals: decimals("CNGN_TOKEN_DECIMALS") },
    { kind: 1, address: ethers.getAddress(required("USDT_TOKEN_ADDRESS")), decimals: decimals("USDT_TOKEN_DECIMALS") },
    { kind: 2, address: ethers.getAddress(required("USDC_TOKEN_ADDRESS")), decimals: decimals("USDC_TOKEN_DECIMALS") }
  ];
  if (new Set(tokenConfigs.map(x => x.address.toLowerCase())).size !== 3) {
    throw new Error("cNGN, USDT and USDC must be three distinct token addresses.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 42421n) throw new Error(`Refusing deployment: expected Enugu testnet chain ID 42421, got ${network.chainId}.`);

  const Factory = await ethers.getContractFactory("AssetOracleMarketManager");
  const manager = await Factory.deploy(deployer.address, treasury, validatorPool);
  await manager.waitForDeployment();

  for (const token of tokenConfigs) {
    const tx = await manager.configureStablecoin(token.kind, token.address, token.decimals);
    await tx.wait();
  }
  await (await manager.setOracleResolver(resolver, true)).wait();

  const extraCreators = (process.env.MARKET_CREATOR_WALLET_ADDRESSES || "")
    .split(",").map(x => x.trim()).filter(Boolean);
  for (const address of extraCreators) {
    await (await manager.setMarketCreator(ethers.getAddress(address), true)).wait();
  }

  console.log("AssetOracleMarketManager deployed on Enugu testnet");
  console.log("Contract:", await manager.getAddress());
  console.log("Owner:", deployer.address);
  console.log("Treasury:", treasury);
  console.log("Validator reward pool:", validatorPool);
  console.log("Oracle resolver:", resolver);
  console.log("Configured stablecoins:", tokenConfigs);
  console.log("Verify all addresses and contract source before interacting with this deployment.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
