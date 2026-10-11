import "dotenv/config";
import { ethers } from "hardhat";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer configured. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");

  const expectedOwner = "0xa785ceba7db4ec6326d63783a896f15824009b17";
  const expectedTreasury = "0x650fBE31b1710b27Ea9eBe03862BC93145Fb3d77";
  const expectedValidatorPool = "0xb86e97b85e816ed0fe170a2dc3b5558232792553";
  const expectedUsdcAddress = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";

  const owner = ethers.getAddress(required("OWNER_WALLET_ADDRESS"));
  const treasury = ethers.getAddress(required("TREASURY_ADDRESS"));
  const validatorPool = ethers.getAddress(required("VALIDATOR_REWARD_POOL_ADDRESS"));
  const resolver = ethers.getAddress(required("ORACLE_RESOLVER_ADDRESS"));
  const usdcAddress = ethers.getAddress(required("USDC_TOKEN_ADDRESS"));

  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`Refusing deployment: OWNER_WALLET_ADDRESS must be the confirmed owner ${expectedOwner}.`);
  }
  if (deployer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Refusing deployment: the deployer signer must be the confirmed owner wallet so initial configuration can be completed safely.");
  }
  if (treasury.toLowerCase() !== expectedTreasury.toLowerCase()) {
    throw new Error(`Refusing deployment: TREASURY_ADDRESS must be the confirmed Treasury ${expectedTreasury}.`);
  }
  if (validatorPool.toLowerCase() !== expectedValidatorPool.toLowerCase()) {
    throw new Error(`Refusing deployment: VALIDATOR_REWARD_POOL_ADDRESS must be the confirmed validator pool ${expectedValidatorPool}.`);
  }
  if (usdcAddress.toLowerCase() !== expectedUsdcAddress.toLowerCase()) {
    throw new Error(`Refusing deployment: Enugu testnet must use the approved USDC address ${expectedUsdcAddress}.`);
  }

  const usdcDecimals = Number(process.env.USDC_TOKEN_DECIMALS || "6");
  if (usdcDecimals !== 6) throw new Error("Refusing deployment: Enugu testnet USDC must verify as 6 decimals.");
  const usdc = new ethers.Contract(usdcAddress, ["function decimals() view returns (uint8)"], ethers.provider);
  const actualDecimals = Number(await usdc.decimals());
  if (actualDecimals !== 6 || actualDecimals !== usdcDecimals) {
    throw new Error(`Refusing deployment: USDC decimals must be 6 on-chain; token reports ${actualDecimals}.`);
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 42421n) throw new Error(`Refusing deployment: expected Enugu testnet chain ID 42421, got ${network.chainId}.`);

  const Factory = await ethers.getContractFactory("AssetOracleMarketManager");
  const manager = await Factory.deploy(owner, treasury, validatorPool);
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
  console.log("Owner:", owner);
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
