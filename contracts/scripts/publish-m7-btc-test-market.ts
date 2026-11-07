import "dotenv/config";
import { artifacts, ethers } from "hardhat";

const CHAIN_ID = 42421n;
const MANAGER_ADDRESS = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
const USDC_ADDRESS = "0xc33741fddEBeA854d265db6F9707900Efb0211a2";
const CHALLENGE_PERIOD = 3600n;
const OBSERVATION_WINDOW = 600;

const QUESTION = "Will BTC/USD be above $76,000 at the observation deadline?";
const RULES =
  "At market close, use the Bitcoin USD price reported by CoinGecko. YES if the reported price is strictly greater than 76000 USD; NO if it is 76000 USD or lower. Use an observation timestamp at or immediately after close time, retrieved within 60 seconds. Record the source response, price and timestamp as evidence. If a reliable observation cannot be obtained within that period, do not resolve the market; allow the contract's unresolved-market timeout and refund rules to apply.";
const EVIDENCE_SOURCE =
  "CoinGecko Bitcoin price API: https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const ABI = [
  "function marketCount() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function validatorRosterConfigured() view returns (bool)",
  "function stablecoins(uint8) view returns (address token,uint8 decimals,bool enabled)",
  "function createMarket(uint8,string,string,string,uint64,uint64) returns (uint256)",
  "function getMarket(uint256) view returns (tuple(uint256 id,address creator,uint8 marketType,uint8 stablecoin,string question,string resolutionRules,string evidenceSource,uint64 closeTime,uint64 challengePeriod,uint64 resolvedAt,uint256 totalYes,uint256 totalNo,uint256 totalStaked,uint8 outcome,uint8 status,bytes32 evidenceHash))",
  "event MarketCreated(uint256 indexed marketId,address indexed creator,uint8 stablecoin,uint64 closeTime,string question)"
];

async function main() {
  console.log("M7: one-time BTC test market publication");

  if (!MANAGER_ADDRESS || !ethers.isAddress(MANAGER_ADDRESS)) {
    throw new Error("Missing or invalid ASSET_ORACLE_MARKET_MANAGER_ADDRESS.");
  }

  const privateKey =
    process.env.AUTOMATION_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("No authorized publication signer is configured. Configure it privately in Codespaces; never paste a private key into chat.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Wrong network: expected ${CHAIN_ID}, received ${network.chainId}`);
  }

  const managerAddress = ethers.getAddress(MANAGER_ADDRESS);
  const code = await ethers.provider.getCode(managerAddress);
  if (code === "0x") throw new Error("No contract code at the configured manager address.");

  const artifact = await artifacts.readArtifact("AssetOracleMarketManager");
  if (ethers.keccak256(code) !== ethers.keccak256(artifact.deployedBytecode)) {
    throw new Error("Manager bytecode does not match the compiled contract artifact.");
  }

  const signer = new ethers.Wallet(privateKey, ethers.provider);
  const signerAddress = await signer.getAddress();
  const manager = new ethers.Contract(managerAddress, ABI, signer);
  const creatorRole = ethers.keccak256(ethers.toUtf8Bytes("MARKET_CREATOR_ROLE"));

  if (!(await manager.hasRole(creatorRole, signerAddress))) {
    throw new Error(`Configured signer ${signerAddress} lacks MARKET_CREATOR_ROLE. No transaction sent.`);
  }
  if (!(await manager.validatorRosterConfigured())) {
    throw new Error("Validator roster is not configured.");
  }

  const usdc = await manager.stablecoins(0);
  if (
    usdc.token.toLowerCase() !== USDC_ADDRESS.toLowerCase() ||
    Number(usdc.decimals) !== 6 ||
    usdc.enabled !== true
  ) {
    throw new Error("Manager USDC configuration does not match the approved Enugu USDC settings.");
  }

  const currentCount = await manager.marketCount();
  if (currentCount !== 0n) {
    throw new Error(`Expected zero markets for the clean-slate test, found ${currentCount}. Stopping without a transaction.`);
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Could not read the latest block.");
  const closeTime = BigInt(latestBlock.timestamp + OBSERVATION_WINDOW);

  console.log("Read-only checks passed.");
  console.log("Network: Enugu, chain 42421");
  console.log("Signer:", signerAddress);
  console.log("Manager:", managerAddress);
  console.log("Market: BTC/USD above $76,000");
  console.log("Observation window: 10 minutes; challenge period: 1 hour");

  const expectedMarketId = await manager.createMarket.staticCall(
    0, QUESTION, RULES, EVIDENCE_SOURCE, closeTime, CHALLENGE_PERIOD
  );
  const gasEstimate = await manager.createMarket.estimateGas(
    0, QUESTION, RULES, EVIDENCE_SOURCE, closeTime, CHALLENGE_PERIOD
  );

  console.log("Simulation passed. Estimated gas:", gasEstimate.toString());
  console.log("Submitting exactly one createMarket transaction.");
  const tx = await manager.createMarket(
    0, QUESTION, RULES, EVIDENCE_SOURCE, closeTime, CHALLENGE_PERIOD,
    { gasLimit: gasEstimate * 120n / 100n }
  );
  console.log("Transaction submitted:", tx.hash);

  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error("Transaction was not confirmed successfully. Inspect its hash before any retry.");
  }

  const parsedLogs = receipt.logs
    .filter((log: any) => log.address.toLowerCase() === managerAddress.toLowerCase())
    .map((log: any) => {
      try { return manager.interface.parseLog(log); }
      catch { return null; }
    });
  const event = parsedLogs.find((parsed: any) => parsed?.name === "MarketCreated");
  if (!event) {
    throw new Error("Confirmed transaction has no MarketCreated event. Do not rerun; inspect the transaction.");
  }

  const marketId = event.args.marketId;
  if (marketId !== expectedMarketId) {
    throw new Error("Market ID differs from the simulated result. Do not rerun.");
  }

  const market = await manager.getMarket(marketId);
  const newCount = await manager.marketCount();
  if (
    newCount !== 1n ||
    market.id !== marketId ||
    market.stablecoin !== 0n ||
    market.status !== 0n ||
    market.question !== QUESTION
  ) {
    throw new Error("Post-publication verification failed. Do not rerun; inspect the transaction.");
  }

  console.log("PUBLICATION VERIFIED");
  console.log("Market ID:", marketId.toString());
  console.log("Transaction:", tx.hash);
  console.log("Block:", receipt.blockNumber);
  console.log("Close time UTC:", new Date(Number(closeTime) * 1000).toISOString());
  console.log("Market count:", newCount.toString());
  console.log("No other lifecycle transactions were submitted.");
}

main().catch((error) => {
  console.error("PUBLICATION STOPPED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
