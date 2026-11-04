import "dotenv/config";
import { createPublicClient, defineChain, getAddress, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pg from "pg";
import {
  CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS,
  ASSET_CHAIN_TESTNET_ID,
  ASSET_CHAIN_TESTNET_RPC_URL,
  HUMAN_VALIDATOR_ADDRESSES,
} from "../src/config/assetOracle.js";

const { Pool } = pg;
const RPC_URL = process.env.ASSET_CHAIN_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL;
const EXPECTED_CHAIN_ID = ASSET_CHAIN_TESTNET_ID;
const USDC = getAddress("0xc33741fddEBeA854d265db6F9707900Efb0211a2");
const managerAddress = CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS;
const abi = [
  { type: "function", name: "validatorRosterConfigured", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "validators", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "stablecoins", stateMutability: "view", inputs: [{ name: "index", type: "uint8" }], outputs: [{ name: "token", type: "address" }, { name: "decimals", type: "uint8" }, { name: "enabled", type: "bool" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

function assertCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  assertCheck(process.env.DATABASE_URL, "DATABASE_URL is missing.");
  assertCheck(/^0x[0-9a-fA-F]{40}$/.test(managerAddress), "ASSET_ORACLE_MARKET_MANAGER_ADDRESS must point to the newly deployed and verified testnet contract.");
  const manager = getAddress(managerAddress);
  const privateKey = process.env.AUTOMATION_PRIVATE_KEY?.trim();
  assertCheck(privateKey && /^0x[0-9a-fA-F]{64}$/.test(privateKey), "AUTOMATION_PRIVATE_KEY must be a 32-byte private key.");
  assertCheck(RPC_URL.startsWith("https://"), "Testnet RPC must use HTTPS.");
  if (process.env.ASSET_CHAIN_ID) {
    assertCheck(Number(process.env.ASSET_CHAIN_ID) === EXPECTED_CHAIN_ID, "Configured chain ID is not 42421.");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 10000 });
  try {
    const db = await pool.query("SELECT current_database() AS database_name, current_user AS database_user, 1 AS connected");
    assertCheck(db.rows[0]?.connected === 1, "Database connectivity check failed.");

    const chain = defineChain({
      id: EXPECTED_CHAIN_ID,
      name: "Asset Chain Enugu Testnet",
      nativeCurrency: { name: "Asset", symbol: "ASSET", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
      testnet: true,
    });
    const client = createPublicClient({ chain, transport: http(RPC_URL) });
    const account = privateKeyToAccount(privateKey as Hex);
    const expectedAutomationWallet = process.env.AUTOMATION_WALLET_ADDRESS?.trim();
    assertCheck(expectedAutomationWallet && /^0x[0-9a-fA-F]{40}$/.test(expectedAutomationWallet) && getAddress(expectedAutomationWallet) === getAddress(account.address), "AUTOMATION_PRIVATE_KEY does not match AUTOMATION_WALLET_ADDRESS.");
    const [chainId, managerCode, rosterConfigured, tokenConfig, usdtConfig, cngnConfig, manualCreatorRole, automatedCreatorRole, gasBalance] = await Promise.all([
      client.getChainId(),
      client.getBytecode({ address: manager }),
      client.readContract({ address: manager, abi, functionName: "validatorRosterConfigured" }),
      client.readContract({ address: manager, abi, functionName: "stablecoins", args: [0] }),
      client.readContract({ address: manager, abi, functionName: "stablecoins", args: [1] }),
      client.readContract({ address: manager, abi, functionName: "stablecoins", args: [2] }),
      client.readContract({ address: manager, abi, functionName: "hasRole", args: [keccak256(toBytes("MARKET_CREATOR_ROLE")), account.address] }),
      client.readContract({ address: manager, abi, functionName: "hasRole", args: [keccak256(toBytes("AUTOMATED_MARKET_CREATOR_ROLE")), account.address] }),
      client.getBalance({ address: account.address }),
    ]);
    assertCheck(chainId === EXPECTED_CHAIN_ID, `Wrong RPC chain ID: expected 42421, received ${chainId}.`);
    assertCheck(managerCode && managerCode !== "0x", "Canonical market manager has no contract bytecode.");
    assertCheck(rosterConfigured, "Validator roster is not configured.");
    assertCheck(tokenConfig[2] && getAddress(tokenConfig[0]) === USDC && Number(tokenConfig[1]) === 6, "Canonical manager USDC configuration does not match the expected token.");
    assertCheck(!usdtConfig[2] && !cngnConfig[2], "Initial Enugu deployment must leave unverified USDT and cNGN disabled.");
    assertCheck(manualCreatorRole, "Automation wallet does not have MARKET_CREATOR_ROLE.");
    assertCheck(automatedCreatorRole, "Automation wallet does not have AUTOMATED_MARKET_CREATOR_ROLE.");

    const roster = [];
    for (let i = 0; i < HUMAN_VALIDATOR_ADDRESSES.length; i++) {
      const actual = await client.readContract({ address: manager, abi, functionName: "validators", args: [BigInt(i)] });
      assertCheck(getAddress(actual) === getAddress(HUMAN_VALIDATOR_ADDRESSES[i]), `Validator mismatch at roster index ${i}.`);
      roster.push(getAddress(actual));
    }

    console.log("READ-ONLY TESTNET AUTOMATION PREFLIGHT PASSED");
    console.log(JSON.stringify({
      databaseConnection: "passed",
      databaseName: db.rows[0].database_name,
      databaseUser: db.rows[0].database_user,
      databaseHost: new URL(process.env.DATABASE_URL!).hostname,
      chainId,
      rpcUrl: RPC_URL,
      marketManager: manager,
      managerBytecodeBytes: (managerCode.length - 2) / 2,
      validatorRosterConfigured: true,
      validators: roster,
      stablecoins: {
        USDC: { address: getAddress(tokenConfig[0]), decimals: Number(tokenConfig[1]), enabled: tokenConfig[2] },
        USDT: { enabled: usdtConfig[2] },
        cNGN: { enabled: cngnConfig[2] },
      },
      automationWallet: account.address,
      marketCreatorRole: manualCreatorRole,
      automatedMarketCreatorRole: automatedCreatorRole,
      nativeGasBalanceWei: gasBalance.toString(),
      transactionsSubmitted: 0,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("READ-ONLY TESTNET PREFLIGHT FAILED:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
