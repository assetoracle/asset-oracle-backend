import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const EXPECTED_CHAIN_ID = 42421;
const EXPECTED_MANAGER = "0xa3c11C6141689050c83f2b53f7e5892BF2fffeD2";
const MARKET_ID = 3n;

const rawKey = process.env.AUTOMATION_PRIVATE_KEY?.trim();
const configuredWallet = process.env.AUTOMATION_WALLET_ADDRESS?.trim();
const configuredManager = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
const verified = process.env.ASSET_ORACLE_NEW_CONTRACT_VERIFIED;

if (!rawKey || !/^0x[0-9a-fA-F]{64}$/.test(rawKey)) throw new Error("Missing or invalid automation private key.");
if (!configuredWallet || !/^0x[0-9a-fA-F]{40}$/.test(configuredWallet)) throw new Error("Missing automation wallet address.");
if (!configuredManager || getAddress(configuredManager) !== getAddress(EXPECTED_MANAGER)) throw new Error("Configured manager does not match the reviewed manager.");
if (verified !== "true") throw new Error("New contract verification flag must be true.");

const account = privateKeyToAccount(rawKey);
if (getAddress(account.address) !== getAddress(configuredWallet)) throw new Error("Automation private key does not match the configured wallet.");

const chain = defineChain({
  id: EXPECTED_CHAIN_ID,
  name: "Asset Chain Enugu Testnet",
  nativeCurrency: { name: "RWA", symbol: "RWA", decimals: 18 },
  rpcUrls: { default: { http: ["https://enugu-rpc.assetchain.org"] } },
});

const manager = getAddress(EXPECTED_MANAGER);
const abi = [
  {
    type: "function", name: "getMarket", stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ name: "market", type: "tuple", components: [
      { name: "id", type: "uint256" }, { name: "creator", type: "address" },
      { name: "marketType", type: "uint8" }, { name: "stablecoin", type: "uint8" },
      { name: "question", type: "string" }, { name: "resolutionRules", type: "string" },
      { name: "evidenceSource", type: "string" }, { name: "closeTime", type: "uint64" },
      { name: "challengePeriod", type: "uint64" }, { name: "resolvedAt", type: "uint64" },
      { name: "totalYes", type: "uint256" }, { name: "totalNo", type: "uint256" },
      { name: "totalStaked", type: "uint256" }, { name: "outcome", type: "uint8" },
      { name: "status", type: "uint8" }, { name: "evidenceHash", type: "bytes32" },
    ] }],
  },
  {
    type: "function", name: "closeMarket", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "uint256" }], outputs: [],
  },
];

const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account, chain, transport: http() });

async function main() {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong RPC chain ID: ${actualChainId}`);

  const code = await publicClient.getBytecode({ address: manager });
  if (!code || code === "0x") throw new Error("No contract bytecode at the reviewed manager.");

  const market = await publicClient.readContract({ address: manager, abi, functionName: "getMarket", args: [MARKET_ID] });
  if (market.status !== 0) throw new Error(`Market 3 is not OPEN (status enum ${market.status}); refusing to submit.`);
  const block = await publicClient.getBlock();
  if (block.timestamp < market.closeTime) throw new Error("Market 3 closing time has not passed; refusing to submit.");

  console.log("Verified Market 3:", market.question);
  console.log("Current status: OPEN; close time has passed.");
  console.log("Manager:", manager);
  console.log("Sender:", account.address);

  const { request } = await publicClient.simulateContract({
    account, address: manager, abi, functionName: "closeMarket", args: [MARKET_ID],
  });
  const gas = await publicClient.estimateContractGas({
    account, address: manager, abi, functionName: "closeMarket", args: [MARKET_ID],
  });
  console.log("Simulation passed. Estimated gas:", gas.toString());

  const hash = await walletClient.writeContract({ ...request, gas });
  console.log("Broadcast transaction:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);

  const updated = await publicClient.readContract({ address: manager, abi, functionName: "getMarket", args: [MARKET_ID] });
  if (updated.status !== 1) throw new Error(`Receipt succeeded but Market 3 status is enum ${updated.status}; manual review required.`);

  console.log("CONFIRMED: Market 3 is CLOSED.");
  console.log("Transaction hash:", hash);
  console.log("Receipt block:", receipt.blockNumber.toString());
}

main().catch((error) => {
  console.error("ONE-TIME MARKET 3 CLOSE FAILED:", error.shortMessage || error.message);
  process.exitCode = 1;
});
