import { createPublicClient, createWalletClient, defineChain, getAddress, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://enugu-rpc.assetchain.org";
const CHAIN_ID = 42421;
const MANAGER = getAddress("0xa3c11C6141689050c83f2b53f7e5892BF2fffeD2");
const MARKET_ID = 1n;
const EXPECTED_QUESTION = "Will BTC/USD be above $76,000 at the observation deadline?";
const STATUS = { OPEN: 0, CLOSED: 1, DISPUTED: 2, SETTLED: 3, REFUNDABLE: 4, CANCELLED: 5, ARBITRATION: 6 };

const abi = [
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ name: "market", type: "tuple", components: [
    { name: "id", type: "uint256" }, { name: "creator", type: "address" }, { name: "marketType", type: "uint8" }, { name: "stablecoin", type: "uint8" },
    { name: "question", type: "string" }, { name: "resolutionRules", type: "string" }, { name: "evidenceSource", type: "string" },
    { name: "closeTime", type: "uint64" }, { name: "challengePeriod", type: "uint64" }, { name: "resolvedAt", type: "uint64" },
    { name: "totalYes", type: "uint256" }, { name: "totalNo", type: "uint256" }, { name: "totalStaked", type: "uint256" },
    { name: "outcome", type: "uint8" }, { name: "status", type: "uint8" }, { name: "evidenceHash", type: "bytes32" }
  ]}] },
  { type: "function", name: "closeMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "refundTimedOutMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] }
];

function requireCheck(ok, message) { if (!ok) throw new Error(message); }
const privateKey = process.env.AUTOMATION_PRIVATE_KEY;
const expectedWallet = process.env.AUTOMATION_WALLET_ADDRESS;
requireCheck(privateKey && /^0x[0-9a-fA-F]{64}$/.test(privateKey), "AUTOMATION_PRIVATE_KEY is missing or invalid.");
requireCheck(expectedWallet && /^0x[0-9a-fA-F]{40}$/.test(expectedWallet), "AUTOMATION_WALLET_ADDRESS is missing or invalid.");

const account = privateKeyToAccount(privateKey);
requireCheck(getAddress(expectedWallet) === account.address, "Automation key does not match the configured automation wallet.");
const chain = defineChain({ id: CHAIN_ID, name: "Asset Chain Enugu Testnet", nativeCurrency: { name: "RWA", symbol: "RWA", decimals: 18 }, rpcUrls: { default: { http: [RPC] } }, testnet: true });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

requireCheck(await publicClient.getChainId() === CHAIN_ID, "Connected to the wrong chain.");
const code = await publicClient.getBytecode({ address: MANAGER });
requireCheck(code && code !== "0x", "Market Manager contract bytecode is missing.");
const initial = await publicClient.readContract({ address: MANAGER, abi, functionName: "getMarket", args: [MARKET_ID] });
requireCheck(initial.id === MARKET_ID, "Market ID mismatch.");
requireCheck(initial.question === EXPECTED_QUESTION, "Market question mismatch; refusing to act.");
requireCheck(initial.stablecoin === 0, "Market stablecoin is not USDC.");
requireCheck(initial.totalStaked === 0n && initial.totalYes === 0n && initial.totalNo === 0n, "Market has stakes; timeout-refund workflow is restricted to the zero-stake test market.");
const now = BigInt(Math.floor(Date.now() / 1000));
requireCheck(now >= initial.closeTime, "Market close time has not passed.");
requireCheck(now >= initial.closeTime + initial.challengePeriod, "Unresolved-market refund timeout has not passed.");
console.log("Preflight passed", JSON.stringify({ marketId: "1", status: initial.status, closeTime: initial.closeTime.toString(), challengePeriod: initial.challengePeriod.toString(), totalStaked: initial.totalStaked.toString(), wallet: account.address, gasBalanceRWA: formatEther(await publicClient.getBalance({ address: account.address })) }, null, 2));

let market = initial;
if (market.status === STATUS.OPEN) {
  const hash = await walletClient.writeContract({ address: MANAGER, abi, functionName: "closeMarket", args: [MARKET_ID] });
  console.log("closeMarket transaction:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  requireCheck(receipt.status === "success", "closeMarket transaction failed; stop and inspect its hash.");
  market = await publicClient.readContract({ address: MANAGER, abi, functionName: "getMarket", args: [MARKET_ID] });
  requireCheck(market.status === STATUS.CLOSED, "Market did not verify as CLOSED after closeMarket.");
  console.log("Verified CLOSED.");
} else {
  requireCheck(market.status === STATUS.CLOSED || market.status === STATUS.REFUNDABLE, `Unexpected status ${market.status}; refusing to continue.`);
  console.log("closeMarket skipped; current state already", market.status);
}

if (market.status === STATUS.CLOSED) {
  const hash = await walletClient.writeContract({ address: MANAGER, abi, functionName: "refundTimedOutMarket", args: [MARKET_ID] });
  console.log("refundTimedOutMarket transaction:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  requireCheck(receipt.status === "success", "refundTimedOutMarket transaction failed; stop and inspect its hash.");
}
const finalMarket = await publicClient.readContract({ address: MANAGER, abi, functionName: "getMarket", args: [MARKET_ID] });
requireCheck(finalMarket.status === STATUS.REFUNDABLE, `Final status verification failed; got ${finalMarket.status}.`);
console.log("M7 MARKET 1 TIMEOUT REFUND VERIFIED");
console.log(JSON.stringify({ marketId: "1", finalStatus: "REFUNDABLE", outcome: finalMarket.outcome, totalStaked: finalMarket.totalStaked.toString(), transactionsSubmittedByThisRun: initial.status === STATUS.OPEN ? 2 : (initial.status === STATUS.CLOSED ? 1 : 0) }, null, 2));
