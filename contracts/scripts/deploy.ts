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

  const expectedOwner = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
  const expectedTreasury = "0x650fBE31b1710b27Ea9eBe03862BC93145Fb3d77";
  const expectedValidatorPool = "0xb86e97b85e816ed0fe170a2dc3b5558232792553";
  const expectedUsdcAddress = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";

  const owner = ethers.getAddress(required("OWNER_WALLET_ADDRESS"));
  const treasury = ethers.getAddress(required("TREASURY_ADDRESS"));
  const validatorPool = ethers.getAddress(required("VALIDATOR_REWARD_POOL_ADDRESS"));
  const resolver = ethers.getAddress(required("ORACLE_RESOLVER_ADDRESS"));
  const usdcAddress = ethers.getAddress(required("USDC_TOKEN_ADDRESS"));
  const validators = [
    ethers.getAddress(required("VALIDATOR_WALLET_1")),
    ethers.getAddress(required("VALIDATOR_WALLET_2")),
    ethers.getAddress(required("VALIDATOR_WALLET_3")),
  ] as const;
  if (new Set(validators.map(address => address.toLowerCase())).size !== 3) {
    throw new Error("Refusing deployment: VALIDATOR_WALLET_1/2/3 must be three distinct wallet addresses.");
  }

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
  if (resolver.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Refusing deployment: the initial Enugu testnet oracle resolver must be the confirmed owner wallet.");
  }

  const extraCreators = (process.env.MARKET_CREATOR_WALLET_ADDRESSES || "")
    .split(",").map(x => x.trim()).filter(Boolean)
    .map(value => ethers.getAddress(value));
  if (extraCreators.some(address => address === ethers.ZeroAddress)) {
    throw new Error("Refusing deployment: MARKET_CREATOR_WALLET_ADDRESSES cannot contain the zero address.");
  }

  // Check the target network before making any token-specific RPC calls.
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 42421n) {
    throw new Error(`Refusing deployment: expected Enugu testnet chain ID 42421, got ${network.chainId}.`);
  }

  const usdcDecimals = Number(process.env.USDC_TOKEN_DECIMALS || "6");
  if (usdcDecimals !== 6) throw new Error("Refusing deployment: Enugu testnet USDC must verify as 6 decimals.");
  const tokenCode = await ethers.provider.getCode(usdcAddress);
  if (tokenCode === "0x") {
    throw new Error("Refusing deployment: no contract code found at the approved USDC address on Enugu testnet.");
  }
  const usdc = new ethers.Contract(usdcAddress, ["function decimals() view returns (uint8)"], ethers.provider);
  const actualDecimals = Number(await usdc.decimals());
  if (actualDecimals !== 6 || actualDecimals !== usdcDecimals) {
    throw new Error(`Refusing deployment: USDC decimals must be 6 on-chain; token reports ${actualDecimals}.`);
  }

  const Factory = await ethers.getContractFactory("AssetOracleMarketManager");
  const manager = await Factory.deploy(owner, treasury, validatorPool);
  await manager.waitForDeployment();

  const deploymentTx = manager.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction was not available for evidence logging.");
  const deploymentReceipt = await deploymentTx.wait();
  if (!deploymentReceipt) throw new Error("Deployment receipt was not available for evidence logging.");

  const stablecoinTx = await manager.configureStablecoin(0, usdcAddress, usdcDecimals);
  const stablecoinReceipt = await stablecoinTx.wait();
  if (!stablecoinReceipt) throw new Error("USDC configuration receipt was not available.");
  const validatorsTx = await manager.configureValidators(validators);
  const validatorsReceipt = await validatorsTx.wait();
  if (!validatorsReceipt) throw new Error("Validator roster configuration receipt was not available.");

  const resolverTx = await manager.setOracleResolver(resolver, true);
  const resolverReceipt = await resolverTx.wait();
  if (!resolverReceipt) throw new Error("Resolver configuration receipt was not available.");

  const creatorReceipts: Array<{ address: string; hash: string; blockNumber: number }> = [];
  for (const address of extraCreators) {
    const creatorTx = await manager.setMarketCreator(address, true);
    const creatorReceipt = await creatorTx.wait();
    if (!creatorReceipt) throw new Error(`Creator configuration receipt was not available for ${address}.`);
    creatorReceipts.push({ address, hash: creatorTx.hash, blockNumber: creatorReceipt.blockNumber });
  }

  console.log("AssetOracleMarketManager deployed on Enugu testnet");
  console.log("Contract:", await manager.getAddress());
  console.log("Deployment transaction:", deploymentTx.hash);
  console.log("Deployment block:", deploymentReceipt.blockNumber);
  console.log("USDC configuration transaction:", stablecoinTx.hash);
  console.log("USDC configuration block:", stablecoinReceipt.blockNumber);
  console.log("Validator roster configuration transaction:", validatorsTx.hash);
  console.log("Validator roster configuration block:", validatorsReceipt.blockNumber);
  console.log("Validators:", validators.join(", "));
  console.log("Resolver configuration transaction:", resolverTx.hash);
  console.log("Resolver configuration block:", resolverReceipt.blockNumber);
  for (const receipt of creatorReceipts) {
    console.log(`Creator configuration for ${receipt.address}: ${receipt.hash} (block ${receipt.blockNumber})`);
  }
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
