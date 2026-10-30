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

  // The dedicated deployer wallet is only the temporary owner during setup.
  // The confirmed main wallet becomes final owner after configuration succeeds.
  const expectedOwner = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
  const expectedTreasury = "0x650fBE31b1710b27Ea9eBe03862BC93145Fb3d77";
  const expectedValidatorPool = "0xb86e97b85e816ed0fe170a2dc3b5558232792553";
  const expectedUsdcAddress = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";
  const expectedValidators = [
    expectedOwner,
    "0xb94185491c78e7331c5d53e9b0df74970b3c9b8a",
    "0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01",
  ].map(address => ethers.getAddress(address));

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

  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`Refusing deployment: OWNER_WALLET_ADDRESS must be the confirmed final owner ${expectedOwner}.`);
  }
  if (deployer.address.toLowerCase() === owner.toLowerCase()) {
    throw new Error("Refusing deployment: use a dedicated deployment wallet, not the main owner wallet, as DEPLOYER_PRIVATE_KEY.");
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
    throw new Error("Refusing deployment: the initial Enugu testnet oracle resolver must be the confirmed final owner wallet.");
  }
  if (validators.some((address, index) => address.toLowerCase() !== expectedValidators[index].toLowerCase())) {
    throw new Error("Refusing deployment: validator wallets must exactly match the three confirmed addresses and order.");
  }
  if (new Set(validators.map(address => address.toLowerCase())).size !== 3) {
    throw new Error("Refusing deployment: VALIDATOR_WALLET_1/2/3 must be three distinct wallet addresses.");
  }

  const extraCreators = (process.env.MARKET_CREATOR_WALLET_ADDRESSES || "")
    .split(",").map(x => x.trim()).filter(Boolean)
    .map(value => ethers.getAddress(value));
  if (extraCreators.some(address => address === ethers.ZeroAddress)) {
    throw new Error("Refusing deployment: MARKET_CREATOR_WALLET_ADDRESSES cannot contain the zero address.");
  }
  if (extraCreators.some(address => address.toLowerCase() === deployer.address.toLowerCase())) {
    throw new Error("Refusing deployment: the temporary deployment wallet must not be configured as a market creator.");
  }

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

  console.log("Network and token checks passed.");
  console.log("Temporary deployer:", deployer.address);
  console.log("Final owner:", owner);
  console.log("The main owner wallet private key is not required by this deployment.");

  // The dedicated wallet temporarily owns the contract so it can configure it.
  const Factory = await ethers.getContractFactory("AssetOracleMarketManager");
  const manager = await Factory.deploy(deployer.address, treasury, validatorPool);
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

  // Check configuration before handing control to the main owner.
  const configuredToken = await manager.stablecoins(0);
  if (
    ethers.getAddress(configuredToken.token).toLowerCase() !== usdcAddress.toLowerCase() ||
    Number(configuredToken.decimals) !== 6 ||
    configuredToken.enabled !== true
  ) throw new Error("Refusing ownership transfer: configured USDC state did not verify.");
  if (!(await manager.validatorRosterConfigured())) {
    throw new Error("Refusing ownership transfer: validator roster is not marked configured.");
  }
  for (let i = 0; i < validators.length; i++) {
    if (
      ethers.getAddress(await manager.validators(i)).toLowerCase() !== validators[i].toLowerCase() ||
      !(await manager.isValidator(validators[i]))
    ) throw new Error(`Refusing ownership transfer: validator ${i + 1} did not verify.`);
  }
  const creatorRole = ethers.keccak256(ethers.toUtf8Bytes("MARKET_CREATOR_ROLE"));
  const resolverRole = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_RESOLVER_ROLE"));
  if (!(await manager.hasRole(resolverRole, owner))) {
    throw new Error("Refusing ownership transfer: final owner lacks the oracle resolver role.");
  }
  for (const address of extraCreators) {
    if (!(await manager.hasRole(creatorRole, address))) {
      throw new Error(`Refusing ownership transfer: market creator role did not verify for ${address}.`);
    }
  }

  const ownershipTx = await manager.transferOwnership(owner);
  const ownershipReceipt = await ownershipTx.wait();
  if (!ownershipReceipt) throw new Error("Ownership transfer receipt was not available.");

  // Verify final ownership and permissions before reporting success.
  const finalOwner = ethers.getAddress(await manager.owner());
  if (finalOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`CRITICAL: final owner mismatch. Expected ${owner}, received ${finalOwner}.`);
  }
  const adminRole = ethers.ZeroHash;
  for (const [label, role] of [["admin", adminRole], ["market creator", creatorRole], ["oracle resolver", resolverRole]] as const) {
    if (!(await manager.hasRole(role, owner))) {
      throw new Error(`CRITICAL: final owner lacks the ${label} role after ownership transfer.`);
    }
  }
  for (const [label, role] of [["admin", adminRole], ["market creator", creatorRole], ["oracle resolver", resolverRole]] as const) {
    if (await manager.hasRole(role, deployer.address)) {
      throw new Error(`CRITICAL: temporary deployer still has the ${label} role after ownership transfer.`);
    }
  }

  console.log("AssetOracleMarketManager deployed and configured on Enugu testnet");
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
  console.log("Ownership transfer transaction:", ownershipTx.hash);
  console.log("Ownership transfer block:", ownershipReceipt.blockNumber);
  console.log("Final owner:", finalOwner);
  console.log("Treasury:", treasury);
  console.log("Validator reward pool:", validatorPool);
  console.log("Oracle resolver:", resolver);
  console.log("Configured testnet token: USDC", usdcAddress, "decimals:", usdcDecimals);
  console.log("PASS: final owner roles verified; temporary deployer privileges revoked.");
  console.log("Run the read-only Enugu preflight against this contract before market activity.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
