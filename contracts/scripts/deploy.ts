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

  const expectedUsdcAddress = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";
  const usdcAddress = ethers.getAddress(required("USDC_TOKEN_ADDRESS"));
  if (usdcAddress.toLowerCase() !== expectedUsdcAddress.toLowerCase()) {
    throw new Error(`Refusing deployment: Enugu testnet must use the approved USDC address ${expectedUsdcAddress}.`);
  }
  const usdcDecimals = Number(process.env.USDC_TOKEN_DECIMALS || "6");
  if (!Number.isInteger(usdcDecimals) || usdcDecimals < 1 || usdcDecimals > 18) {
    throw new Error("USDC_TOKEN_DECIMALS must be an integer from 1 to 18.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 42421n) throw new Error(`Refusing deployment: expected Enugu testnet chain ID 42421, got ${network.chainId}.`);

  const Factory = await ethers.getContractFactory("AssetOracleMarketManager");
  const manager = await Factory.deploy(deployer.address, treasury, validatorPool);
  await manager.waitForDeployment();

  await (await manager.configureStablecoin(0, usdcAddress, usdcDecimals)).wait();
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
  console.log("Configured testnet token: USDC", usdcAddress, "decimals:", usdcDecimals);
  console.log("Verify all addresses and contract source before interacting with this deployment.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
