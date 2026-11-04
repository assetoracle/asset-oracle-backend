import "dotenv/config";
import { artifacts, ethers } from "hardhat";

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
  "function tradingFeeBps() view returns (uint256)",
  "function MAX_TRADING_FEE_BPS() view returns (uint256)",
  "function settlementFeeBps() view returns (uint256)",
  "function VALIDATOR_SHARE_OF_SETTLEMENT_FEE_BPS() view returns (uint256)",
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

  // Configuration checks alone cannot prove the deployed contract runs the
  // audited source. Compare the complete runtime bytecode to this build's
  // artifact before trusting the manager's state or permitting market activity.
  const artifact = await artifacts.readArtifact("AssetOracleMarketManager");
  const deployedRuntimeHash = ethers.keccak256(managerCode);
  const expectedRuntimeHash = ethers.keccak256(artifact.deployedBytecode);
  if (deployedRuntimeHash !== expectedRuntimeHash) {
    throw new Error(
      `Manager runtime bytecode does not match the current AssetOracleMarketManager artifact. Expected ${expectedRuntimeHash}, received ${deployedRuntimeHash}. Redeploy and verify the manager before continuing.`,
    );
  }
  console.log(`PASS manager runtime bytecode matches current source artifact: ${expectedRuntimeHash}`);

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
  const usdtConfig = await manager.stablecoins(1);
  const cngnConfig = await manager.stablecoins(2);
  if (usdtConfig.enabled !== false || cngnConfig.enabled !== false) {
    throw new Error("Initial Enugu testnet deployment must leave USDT and cNGN disabled until their token addresses and decimals are verified.");
  }
  console.log("PASS unverified USDT and cNGN remain disabled");

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
  const automatedCreatorRole = ethers.keccak256(ethers.toUtf8Bytes("AUTOMATED_MARKET_CREATOR_ROLE"));
  const adminRole = ethers.ZeroHash;
  if (!(await manager.hasRole(adminRole, EXPECTED_OWNER))) throw new Error("Owner lacks DEFAULT_ADMIN_ROLE.");
  if (!(await manager.hasRole(creatorRole, EXPECTED_OWNER))) throw new Error("Owner lacks MARKET_CREATOR_ROLE.");
  if (!(await manager.hasRole(automatedCreatorRole, EXPECTED_OWNER))) throw new Error("Owner lacks AUTOMATED_MARKET_CREATOR_ROLE.");
  if (!(await manager.hasRole(resolverRole, EXPECTED_OWNER))) throw new Error("Owner lacks ORACLE_RESOLVER_ROLE.");
  console.log("PASS owner has admin, manual creator, automated creator, and oracle-resolver roles");

  const automationWalletRaw = process.env.AUTOMATION_WALLET_ADDRESS?.trim();
  if (!automationWalletRaw || !ethers.isAddress(automationWalletRaw)) {
    throw new Error("AUTOMATION_WALLET_ADDRESS is missing or invalid.");
  }
  const automationWallet = ethers.getAddress(automationWalletRaw);
  if (!(await manager.hasRole(creatorRole, automationWallet))) throw new Error("Automation wallet lacks MARKET_CREATOR_ROLE.");
  if (!(await manager.hasRole(automatedCreatorRole, automationWallet))) throw new Error("Automation wallet lacks AUTOMATED_MARKET_CREATOR_ROLE.");
  console.log(`PASS automation wallet has both publication roles: ${automationWallet}`);

  const tradingFeeBps = Number(await manager.tradingFeeBps());
  const maxTradingFeeBps = Number(await manager.MAX_TRADING_FEE_BPS());
  const settlementFeeBps = Number(await manager.settlementFeeBps());
  const validatorShareBps = Number(await manager.VALIDATOR_SHARE_OF_SETTLEMENT_FEE_BPS());
  if (tradingFeeBps !== 100 || maxTradingFeeBps !== 100) throw new Error(`Transaction fee policy mismatch: expected 100 bps (1%) default and cap, received ${tradingFeeBps} bps default and ${maxTradingFeeBps} bps cap.`);
  console.log("PASS transaction fee policy: 1% charged separately from stake");
  if (settlementFeeBps !== 1000) throw new Error(`Initial settlement fee mismatch: expected 1000 bps (10%), received ${settlementFeeBps}.`);
  if (validatorShareBps !== 1500) throw new Error(`Validator fee share mismatch: expected 1500 bps (15%), received ${validatorShareBps}.`);
  console.log("PASS settlement fee policy: 10% fee, 15% validator share, 85% Treasury share");

  const escrowAddressRaw = process.env.ASSET_ORACLE_TESTNET_PAID_SUBMISSION_ESCROW_ADDRESS?.trim();
  if (!escrowAddressRaw || !ethers.isAddress(escrowAddressRaw)) {
    throw new Error("ASSET_ORACLE_TESTNET_PAID_SUBMISSION_ESCROW_ADDRESS is missing or invalid; paid proposal escrow remains disabled.");
  }
  const escrowAddress = ethers.getAddress(escrowAddressRaw);
  const escrowCode = await ethers.provider.getCode(escrowAddress);
  if (escrowCode === "0x") throw new Error("No contract code at the configured manual proposal escrow address.");
  const escrowArtifact = await artifacts.readArtifact("ManualProposalFeeEscrow");
  const escrowRuntimeHash = ethers.keccak256(escrowCode);
  const expectedEscrowRuntimeHash = ethers.keccak256(escrowArtifact.deployedBytecode);
  if (escrowRuntimeHash !== expectedEscrowRuntimeHash) {
    throw new Error(`Escrow runtime bytecode mismatch. Expected ${expectedEscrowRuntimeHash}, received ${escrowRuntimeHash}.`);
  }
  const escrow = new ethers.Contract(escrowAddress, [
    "function usdc() view returns (address)",
    "function treasury() view returns (address)",
    "function PROPOSAL_FEE() view returns (uint256)",
    "function REVIEWER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], ethers.provider);
  assertAddress("proposal escrow USDC", await escrow.usdc(), EXPECTED_USDC);
  assertAddress("proposal escrow Treasury", await escrow.treasury(), EXPECTED_TREASURY);
  if ((await escrow.PROPOSAL_FEE()) !== 10_000_000n) throw new Error("Proposal escrow fee must be exactly 10 USDC (10,000,000 atomic units).");
  const reviewerRole = await escrow.REVIEWER_ROLE();
  if (!(await escrow.hasRole(reviewerRole, EXPECTED_OWNER))) throw new Error("Confirmed owner does not have the escrow reviewer role.");
  console.log(`PASS proposal escrow runtime bytecode: ${escrowRuntimeHash}`);
  console.log("PASS manual proposal fee: 10 USDC held until approval or rejection/refund");
  console.log("PASS confirmed owner has escrow reviewer permissions");

  console.log(`PASS manager contract code: ${normalizedManager}`);
  console.log(`INFO current market count: ${(await manager.marketCount()).toString()}`);
  console.log("PREFLIGHT PASSED. This script is read-only and submits no transactions.");
}

main().catch((error) => {
  console.error("PREFLIGHT FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
