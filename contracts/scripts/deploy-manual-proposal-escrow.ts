import "dotenv/config";
import { ethers } from "hardhat";

const EXPECTED_CHAIN_ID = 42421n;
const EXPECTED_OWNER = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
const EXPECTED_TREASURY = "0x650fBE31b1710b27Ea9eBe03862BC93145Fb3d77";
const EXPECTED_USDC = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer configured. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong network: expected ${EXPECTED_CHAIN_ID}, received ${network.chainId}`);

  const admin = ethers.getAddress(required("OWNER_WALLET_ADDRESS"));
  const treasury = ethers.getAddress(required("TREASURY_ADDRESS"));
  const usdcAddress = ethers.getAddress(required("USDC_TOKEN_ADDRESS"));
  if (admin.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) throw new Error("Refusing escrow deployment: owner does not match the confirmed Enugu admin wallet.");
  if (treasury.toLowerCase() !== EXPECTED_TREASURY.toLowerCase()) throw new Error("Refusing escrow deployment: Treasury does not match the confirmed Treasury wallet.");
  if (usdcAddress.toLowerCase() !== EXPECTED_USDC.toLowerCase()) throw new Error("Refusing escrow deployment: Enugu escrow must use the approved USDC contract.");

  const tokenCode = await ethers.provider.getCode(usdcAddress);
  if (tokenCode === "0x") throw new Error("Approved USDC contract has no code on Enugu.");
  const token = new ethers.Contract(usdcAddress, ["function decimals() view returns (uint8)"], ethers.provider);
  if (Number(await token.decimals()) !== 6) throw new Error("Approved Enugu USDC must report exactly six decimals.");

  console.log("Read-only checks passed. Deploying a separate proposal escrow.");
  console.log("Deployer:", deployer.address);
  console.log("Reviewer/admin:", admin);
  console.log("Treasury:", treasury);
  console.log("USDC:", usdcAddress);

  const Factory = await ethers.getContractFactory("ManualProposalFeeEscrow");
  const escrow = await Factory.deploy(admin, usdcAddress, treasury);
  await escrow.waitForDeployment();
  const tx = escrow.deploymentTransaction();
  if (!tx) throw new Error("Escrow deployment transaction unavailable.");
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Escrow deployment did not confirm successfully.");

  const deployedAddress = await escrow.getAddress();
  const runtime = await ethers.provider.getCode(deployedAddress);
  if (runtime === "0x") throw new Error("Escrow deployment address has no runtime bytecode.");
  if ((await escrow.treasury()).toLowerCase() !== treasury.toLowerCase()) throw new Error("Escrow Treasury verification failed.");
  if ((await escrow.usdc()).toLowerCase() !== usdcAddress.toLowerCase()) throw new Error("Escrow USDC verification failed.");
  const reviewerRole = await escrow.REVIEWER_ROLE();
  if (!(await escrow.hasRole(reviewerRole, admin))) throw new Error("Configured admin is not an escrow reviewer.");

  console.log("ManualProposalFeeEscrow deployed and verified.");
  console.log("Escrow address:", deployedAddress);
  console.log("Deployment transaction:", tx.hash);
  console.log("Deployment block:", receipt.blockNumber);
  console.log("Runtime bytecode hash:", ethers.keccak256(runtime));
  console.log("Admin reviewer:", admin);
  console.log("Treasury:", treasury);
  console.log("USDC:", usdcAddress);
  console.log("Fixed proposal fee: 10000000 atomic units (10 USDC).");
  console.log("No market manager was deployed or changed by this script.");
}

main().catch(error => {
  console.error("Escrow deployment failed:", error);
  process.exitCode = 1;
});
