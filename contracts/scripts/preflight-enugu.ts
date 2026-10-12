import "dotenv/config";
import { ethers } from "hardhat";

const EXPECTED_CHAIN_ID = 42421n;
const EXPECTED_OWNER = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
const EXPECTED_TREASURY = "0x650fBE31b1710b27Ea9eBe03862BC93145Fb3d77";
const EXPECTED_VALIDATOR_POOL = "0xb86e97b85e816ed0fe170a2dc3b5558232792553";
const EXPECTED_USDC = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";
const EXPECTED_VALIDATORS = [
  EXPECTED_OWNER,
  "0xb94185491c78e7331c5d53e9b0df74970b3c9b8a",
  "0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];
const MANAGER_ABI = [
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
  "function validatorRewardPool() view returns (address)",
  "function stablecoins(uint8) view returns (address token, uint8 decimals, bool enabled)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function validators(uint256) view returns (address)",
  "function isValidator(address) view returns (bool)",
  "function validatorRosterConfigured() view returns (bool)",
  "function marketCount() view returns (uint256)",
];

function assertAddress(label: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
  }
  console.log(`PASS ${label}: ${actual}`);
}

async function main() {
  console.log("Asset Oracle: read-only Enugu preflight");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong network: expected chain ID ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);
  }
  console.log(`PASS chain ID: ${network.chainId}`);

  const tokenCode = await ethers.provider.getCode(EXPECTED_USDC);
  if (tokenCode === "0x") throw new Error("No contract code at the approved Enugu USDC address.");
  const token = new ethers.Contract(EXPECTED_USDC, ERC20_ABI, ethers.provider);
  const decimals = Number(await token.decimals());
  if (decimals !== 6) throw new Error(`USDC decimals mismatch: expected 6, received ${decimals}`);
  console.log(`PASS approved USDC code and decimals: ${EXPECTED_USDC} (6)`);

  const managerAddress = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  if (!managerAddress) {
    console.error("BLOCKED: ASSET_ORACLE_MARKET_MANAGER_ADDRESS is not configured.");
    console.error("No market calls or transactions were sent. Set this only after independently verifying the deployment address and transaction.");
    process.exitCode = 2;
    return;
  }

  const normalizedManager = ethers.getAddress(managerAddress);
  const managerCode = await ethers.provider.getCode(normalizedManager);
  if (managerCode === "0x") throw new Error("No contract code at ASSET_ORACLE_MARKET_MANAGER_ADDRESS.");
  const manager = new ethers.Contract(normalizedManager, MANAGER_ABI, ethers.provider);

  assertAddress("manager owner", await manager.owner(), EXPECTED_OWNER);
  assertAddress("manager Treasury", await manager.treasury(), EXPECTED_TREASURY);
  assertAddress("manager validator reward pool", await manager.validatorRewardPool(), EXPECTED_VALIDATOR_POOL);

  const stablecoin = await manager.stablecoins(0);
  assertAddress("manager USDC token", stablecoin.token, EXPECTED_USDC);
  if (Number(stablecoin.decimals) !== 6 || stablecoin.enabled !== true) {
    throw new Error(`Manager USDC config mismatch: decimals=${stablecoin.decimals}, enabled=${stablecoin.enabled}`);
  }
  console.log("PASS manager USDC config: enabled, 6 decimals");

  if (!(await manager.validatorRosterConfigured())) {
    throw new Error("Validator roster is not configured.");
  }
  for (let i = 0; i < EXPECTED_VALIDATORS.length; i++) {
    const expected = ethers.getAddress(EXPECTED_VALIDATORS[i]);
    assertAddress(`validator ${i + 1}`, await manager.validators(i), expected);
    if (!(await manager.isValidator(expected))) {
      throw new Error(`Validator ${i + 1} is not marked active by the contract.`);
    }
  }
  console.log("PASS fixed three-validator roster and membership");

  const creatorRole = ethers.keccak256(ethers.toUtf8Bytes("MARKET_CREATOR_ROLE"));
  const resolverRole = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_RESOLVER_ROLE"));
  const adminRole = ethers.ZeroHash;
  if (!(await manager.hasRole(adminRole, EXPECTED_OWNER))) throw new Error("Owner lacks DEFAULT_ADMIN_ROLE.");
  if (!(await manager.hasRole(creatorRole, EXPECTED_OWNER))) throw new Error("Owner lacks MARKET_CREATOR_ROLE.");
  if (!(await manager.hasRole(resolverRole, EXPECTED_OWNER))) throw new Error("Owner lacks ORACLE_RESOLVER_ROLE.");
  console.log("PASS owner has admin, market-creator, and oracle-resolver roles");

  console.log(`PASS manager contract code: ${normalizedManager}`);
  console.log(`INFO current market count: ${(await manager.marketCount()).toString()}`);
  console.log("PREFLIGHT PASSED. This script is read-only and submits no transactions.");
}

main().catch((error) => {
  console.error("PREFLIGHT FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
