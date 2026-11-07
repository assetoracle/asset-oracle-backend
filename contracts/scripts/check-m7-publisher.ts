import "dotenv/config";
import { ethers } from "hardhat";

async function main() {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  const managerAddress = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is not configured.");
  if (!managerAddress || !ethers.isAddress(managerAddress)) {
    throw new Error("ASSET_ORACLE_MARKET_MANAGER_ADDRESS is missing or invalid.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 42421n) throw new Error(`Wrong chain: ${network.chainId}`);

  const signer = new ethers.Wallet(key, ethers.provider);
  const address = await signer.getAddress();
  const manager = new ethers.Contract(
    ethers.getAddress(managerAddress),
    [
      "function hasRole(bytes32,address) view returns (bool)",
      "function marketCount() view returns (uint256)"
    ],
    ethers.provider
  );

  const role = ethers.keccak256(ethers.toUtf8Bytes("MARKET_CREATOR_ROLE"));
  const authorized = await manager.hasRole(role, address);
  const balance = await ethers.provider.getBalance(address);
  const marketCount = await manager.marketCount();

  console.log("READ-ONLY SIGNER CHECK");
  console.log("Chain ID:", network.chainId.toString());
  console.log("Signer address:", address);
  console.log("Has MARKET_CREATOR_ROLE:", authorized);
  console.log("Native RWA balance (wei):", balance.toString());
  console.log("Market count:", marketCount.toString());
  console.log("No transaction was submitted.");

  if (!authorized) {
    throw new Error("This DEPLOYER_PRIVATE_KEY wallet cannot publish a manual market. Stop here.");
  }
  if (balance === 0n) {
    throw new Error("Signer has no native gas balance. Stop here.");
  }
}

main().catch((error) => {
  console.error("SIGNER CHECK FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
