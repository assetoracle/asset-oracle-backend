import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { database } from "../config/database.js";
import {
  CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS,
  ASSET_CHAIN_TESTNET_ID,
  ASSET_CHAIN_TESTNET_RPC_URL,
  HUMAN_VALIDATOR_ADDRESSES,
} from "../config/assetOracle.js";
import { initializeMarketStore, listMarketProposals, listAutomatedMarketProposals, recordOnchainPublication } from "../services/marketStore.js";

const USDC = "0xc33741fddEBeA854d265db6F9707900Efb0211a2" as Address;
const EXPLORER = process.env.ASSET_CHAIN_EXPLORER_URL || "https://scan-testnet.assetchain.org";
const CHALLENGE_PERIOD_SECONDS = 3600n;
const MAX_MARKETS_PER_RUN = 500;
const MAX_PAYOUT_BATCHES_PER_RUN = 10;
const PAYOUT_BATCH_SIZE = 50n;
const DISPUTE_RESOLUTION_TIMEOUT_SECONDS = 7n * 24n * 60n * 60n;
import { buildMarketScanIds, orderMarketIdsFromCursor, nextMarketCursor } from "./marketLifecycleScheduling.js";

const chain = defineChain({
  id: ASSET_CHAIN_TESTNET_ID,
  name: "Asset Chain Enugu Testnet",
  nativeCurrency: { name: "Asset", symbol: "ASSET", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ASSET_CHAIN_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL] } },
  blockExplorers: { default: { name: "Asset Chain Testnet Explorer", url: EXPLORER } },
  testnet: true,
});

const managerAbi = [
  { type: "function", name: "marketCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "participantCountByMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimCountByMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distributePayouts", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }, { name: "startIndex", type: "uint256" }, { name: "batchSize", type: "uint256" }], outputs: [] },
  { type: "function", name: "refundTimedOutMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "refundDisputedTimeout", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ name: "marketId", type: "uint256" }], outputs: [{ name: "market", type: "tuple", components: [
    { name: "id", type: "uint256" }, { name: "creator", type: "address" }, { name: "marketType", type: "uint8" }, { name: "stablecoin", type: "uint8" },
    { name: "question", type: "string" }, { name: "resolutionRules", type: "string" }, { name: "evidenceSource", type: "string" },
    { name: "closeTime", type: "uint64" }, { name: "challengePeriod", type: "uint64" }, { name: "resolvedAt", type: "uint64" },
    { name: "totalYes", type: "uint256" }, { name: "totalNo", type: "uint256" }, { name: "totalStaked", type: "uint256" },
    { name: "outcome", type: "uint8" }, { name: "status", type: "uint8" }, { name: "evidenceHash", type: "bytes32" },
  ] }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "validatorRosterConfigured", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "validators", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "stablecoins", stateMutability: "view", inputs: [{ name: "", type: "uint8" }], outputs: [{ name: "token", type: "address" }, { name: "decimals", type: "uint8" }, { name: "enabled", type: "bool" }] },
  { type: "function", name: "createMarket", stateMutability: "nonpayable", inputs: [
    { name: "stablecoin", type: "uint8" }, { name: "question", type: "string" }, { name: "resolutionRules", type: "string" },
    { name: "evidenceSource", type: "string" }, { name: "closeTime", type: "uint64" }, { name: "challengePeriod", type: "uint64" },
  ], outputs: [{ name: "marketId", type: "uint256" }] },
  { type: "function", name: "createAutomatedMarket", stateMutability: "nonpayable", inputs: [
    { name: "stablecoin", type: "uint8" }, { name: "question", type: "string" }, { name: "resolutionRules", type: "string" },
    { name: "evidenceSource", type: "string" }, { name: "closeTime", type: "uint64" }, { name: "challengePeriod", type: "uint64" },
  ], outputs: [{ name: "marketId", type: "uint256" }] },
  { type: "function", name: "closeMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "function", name: "finalizeMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "uint256" }], outputs: [] },
  { type: "event", name: "MarketCreated", anonymous: false, inputs: [
    { indexed: true, name: "marketId", type: "uint256" }, { indexed: true, name: "creator", type: "address" },
    { indexed: false, name: "stablecoin", type: "uint8" }, { indexed: false, name: "closeTime", type: "uint64" },
    { indexed: false, name: "question", type: "string" },
  ] },
  { type: "event", name: "MarketClosed", anonymous: false, inputs: [{ indexed: true, name: "marketId", type: "uint256" }] },
  { type: "event", name: "MarketFinalized", anonymous: false, inputs: [{ indexed: true, name: "marketId", type: "uint256" }, { indexed: false, name: "outcome", type: "uint8" }] },
] as const;

function requiredPrivateKey(): Hex {
  const raw = process.env.AUTOMATION_PRIVATE_KEY?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("AUTOMATION_PRIVATE_KEY must be a dedicated 32-byte private key. No chain transactions were submitted.");
  }
  return raw as Hex;
}

async function main(): Promise<void> {
  if (process.env.ASSET_ORACLE_NEW_CONTRACT_VERIFIED !== "true") {
    throw new Error("ASSET_ORACLE_NEW_CONTRACT_VERIFIED must be true after deployment preflight. Lifecycle worker stopped before database access or transactions.");
  }
  if (process.env.ASSET_CHAIN_ID && Number(process.env.ASSET_CHAIN_ID) !== ASSET_CHAIN_TESTNET_ID) {
    throw new Error("This worker is testnet-only and refuses any chain ID other than 42421.");
  }
  const account = privateKeyToAccount(requiredPrivateKey());
  const expectedAutomationWallet = process.env.AUTOMATION_WALLET_ADDRESS?.trim();
  if (!expectedAutomationWallet || !/^0x[0-9a-fA-F]{40}$/.test(expectedAutomationWallet) || getAddress(expectedAutomationWallet) !== getAddress(account.address)) {
    throw new Error("AUTOMATION_PRIVATE_KEY does not match the configured dedicated AUTOMATION_WALLET_ADDRESS. No transaction was submitted.");
  }
  if (!CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS)) {
    throw new Error("New testnet market manager address is not configured. No transaction was submitted.");
  }
  const manager = getAddress(CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS);
  const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
  const walletClient = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== ASSET_CHAIN_TESTNET_ID) throw new Error(`RPC chain ID mismatch: expected 42421, got ${actualChainId}`);
  const code = await publicClient.getBytecode({ address: manager });
  if (!code || code === "0x") throw new Error("No contract bytecode found at the configured market manager.");
  const roster = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "validatorRosterConfigured" });
  if (!roster) throw new Error("Validator roster is not configured; automation stopped.");
  for (let index = 0; index < HUMAN_VALIDATOR_ADDRESSES.length; index++) {
    const configuredValidator = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "validators", args: [BigInt(index)] });
    if (getAddress(configuredValidator) !== getAddress(HUMAN_VALIDATOR_ADDRESSES[index])) {
      throw new Error(`Validator roster mismatch at index ${index}; expected ${HUMAN_VALIDATOR_ADDRESSES[index]}, got ${configuredValidator}. Automation stopped.`);
    }
  }
  const token = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "stablecoins", args: [0] });
  if (!token[2] || getAddress(token[0]) !== getAddress(USDC) || Number(token[1]) !== 6) {
    throw new Error("Canonical manager USDC configuration failed validation; automation stopped.");
  }

  const [manualCreatorRole, automatedCreatorRole] = await Promise.all([
    publicClient.readContract({ address: manager, abi: managerAbi, functionName: "hasRole", args: [keccak256(toBytes("MARKET_CREATOR_ROLE")), account.address] }),
    publicClient.readContract({ address: manager, abi: managerAbi, functionName: "hasRole", args: [keccak256(toBytes("AUTOMATED_MARKET_CREATOR_ROLE")), account.address] }),
  ]);
  if (!manualCreatorRole || !automatedCreatorRole) {
    throw new Error(`Automation wallet ${account.address} must have both MARKET_CREATOR_ROLE and AUTOMATED_MARKET_CREATOR_ROLE on the new testnet manager.`);
  }

  // Prevent overlapping cron runs from submitting duplicate transactions.
  const lockClient = await database.connect();
  const lock = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [42421001]);
  if (!lock.rows[0]?.locked) {
    lockClient.release();
    await database.end();
    console.log("Another lifecycle worker is running; exiting without changes.");
    return;
  }

  try {
    await initializeMarketStore();
    await database.query(`
      CREATE TABLE IF NOT EXISTS market_lifecycle_payout_progress (
        market_id TEXT PRIMARY KEY,
        next_index INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS market_lifecycle_worker_state (
        worker_key TEXT PRIMARY KEY,
        next_market_id INTEGER NOT NULL DEFAULT 1,
        next_payout_market_id INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await database.query(`
      INSERT INTO market_lifecycle_worker_state (worker_key)
      VALUES ('enugu')
      ON CONFLICT (worker_key) DO NOTHING
    `);
    const workerState = await database.query<{ next_market_id: number; next_payout_market_id: number }>(
      "SELECT next_market_id, next_payout_market_id FROM market_lifecycle_worker_state WHERE worker_key = 'enugu'",
    );
    let nextPayoutMarketId = Number(workerState.rows[0]?.next_payout_market_id ?? 1);
    const [manualProposals, automatedProposals] = await Promise.all([listMarketProposals(), listAutomatedMarketProposals()]);
    const proposals = [...manualProposals, ...automatedProposals];
    let marketCount = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "marketCount" });

    // Publish only proposals already explicitly approved by the admin. The proposal UUID
    // is embedded in resolutionRules so a retry can reconcile an on-chain success safely.
    for (const proposal of proposals.filter((item) => item.status === "APPROVED" && !item.onchainTxHash && !item.onchainMarketId)) {
      const closeTime = BigInt(Math.floor(Date.parse(proposal.closesAt) / 1000));
      if (closeTime <= BigInt(Math.floor(Date.now() / 1000))) {
        console.warn(`Skipping expired approved proposal ${proposal.id}; it needs an updated close time.`);
        continue;
      }
      const rules = JSON.stringify({
        ...proposal.resolutionRule,
        resolvesAt: proposal.resolvesAt,
        description: proposal.resolutionRule.description,
        proposalId: proposal.id,
      });

      // Reconcile a previous successful createMarket transaction if the worker stopped
      // before writing its DB record.
      let recovered = false;
      marketCount = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "marketCount" });
      const count = Number(marketCount);
      for (let id = 1; id <= count; id++) {
        const existing = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "getMarket", args: [BigInt(id)] });
        if (existing.question === proposal.question && existing.resolutionRules.includes(proposal.id) && Number(existing.marketType) === (proposal.origin === "AUTOMATED" ? 1 : 0)) {
          if (existing.challengePeriod !== CHALLENGE_PERIOD_SECONDS) {
            throw new Error(`Recovered market ${id} has challenge period ${existing.challengePeriod}; expected exactly ${CHALLENGE_PERIOD_SECONDS}. Manual reconciliation required.`);
          }
          const logs = await publicClient.getLogs({ address: manager, event: managerAbi[16], fromBlock: 0n, toBlock: "latest" }).catch(() => []);
          const created = logs.find((log) => log.args.marketId === BigInt(id));
          if (created?.transactionHash) {
            const stored = await recordOnchainPublication({ id: proposal.id, marketId: String(id), txHash: created.transactionHash, managerAddress: manager, chainId: actualChainId });
            console.log(`Recovered publication for proposal ${proposal.id}: market ${id}`);
            recovered = Boolean(stored);
          }
          if (recovered) break;
          throw new Error(`Market for proposal ${proposal.id} exists on-chain but its creation log could not be recovered. Manual reconciliation required; refusing to create a duplicate.`);
        }
      }
      if (recovered) continue;

      const hash = proposal.origin === "AUTOMATED"
        ? await walletClient.writeContract({
            address: manager, abi: managerAbi, functionName: "createAutomatedMarket",
            args: [0, proposal.question, rules, proposal.resolutionRule.sourceId, closeTime, CHALLENGE_PERIOD_SECONDS],
          })
        : await walletClient.writeContract({
            address: manager, abi: managerAbi, functionName: "createMarket",
            args: [0, proposal.question, rules, proposal.resolutionRule.sourceId, closeTime, CHALLENGE_PERIOD_SECONDS],
          });
      console.log(`Submitted ${proposal.origin === "AUTOMATED" ? "createAutomatedMarket" : "createMarket"} for proposal ${proposal.id}: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error(`createMarket transaction failed: ${hash}`);
      const events = parseEventLogs({ abi: managerAbi, logs: receipt.logs.filter((log) => getAddress(log.address) === manager), eventName: "MarketCreated", strict: false });
      const created = events.find((event) => event.args.question === proposal.question && event.args.creator && getAddress(event.args.creator) === getAddress(account.address) && event.args.closeTime === closeTime);
      if (!created || created.args.marketId === undefined) throw new Error(`Confirmed transaction did not emit the expected MarketCreated event: ${hash}`);
      const publishedMarket = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "getMarket", args: [created.args.marketId] });
      const expectedMarketType = proposal.origin === "AUTOMATED" ? 1 : 0;
      if (Number(publishedMarket.marketType) !== expectedMarketType) {
        throw new Error(`Published market ${created.args.marketId} has the wrong market type for proposal ${proposal.id}; manual reconciliation required.`);
      }
      if (publishedMarket.challengePeriod !== CHALLENGE_PERIOD_SECONDS) {
        throw new Error(`Published market ${created.args.marketId} has challenge period ${publishedMarket.challengePeriod}; expected exactly ${CHALLENGE_PERIOD_SECONDS}. Manual reconciliation required.`);
      }
      const stored = await recordOnchainPublication({ id: proposal.id, marketId: created.args.marketId.toString(), txHash: hash, managerAddress: manager, chainId: actualChainId });
      if (!stored) throw new Error(`On-chain market ${created.args.marketId} exists but could not be saved to the database. Reconciliation is required.`);
      console.log(`Published approved proposal ${proposal.id} as market ${created.args.marketId}: ${EXPLORER}/tx/${hash}`);
    }

    // Settlement automation never chooses an outcome. The 2-of-3 human validator
    // consensus and the contract's challenge window remain authoritative.
    marketCount = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "marketCount" });
    const currentCount = Number(marketCount);
    const now = BigInt(Math.floor(Date.now() / 1000));
    let payoutBatchesProcessed = 0;
    const scanIds = buildMarketScanIds(currentCount, Number(workerState.rows[0]?.next_market_id ?? 1), MAX_MARKETS_PER_RUN);
    const orderedMarketIds = orderMarketIdsFromCursor(scanIds, nextPayoutMarketId, currentCount);
    for (const id of orderedMarketIds) {
      const market = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "getMarket", args: [BigInt(id)] });
      if (market.status === 0 && market.closeTime <= now) {
        const hash = await walletClient.writeContract({ address: manager, abi: managerAbi, functionName: "closeMarket", args: [BigInt(id)] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "success") console.log(`Closed expired market ${id}: ${EXPLORER}/tx/${hash}`);
        else console.error(`closeMarket failed for market ${id}: ${hash}`);
      } else if (market.status === 1 && market.closeTime + market.challengePeriod <= now) {
        const hash = await walletClient.writeContract({ address: manager, abi: managerAbi, functionName: "refundTimedOutMarket", args: [BigInt(id)] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "success") console.log(`Marked unresolved market ${id} refundable after its timeout: ${EXPLORER}/tx/${hash}`);
        else console.error(`refundTimedOutMarket failed for market ${id}: ${hash}`);
      } else if (market.status === 2 && market.resolvedAt + market.challengePeriod <= now) {
        const hash = await walletClient.writeContract({ address: manager, abi: managerAbi, functionName: "finalizeMarket", args: [BigInt(id)] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "success") console.log(`Finalized validator-resolved market ${id}: ${EXPLORER}/tx/${hash}`);
        else console.error(`finalizeMarket failed for market ${id}: ${hash}`);
      } else if (market.status === 6 && market.resolvedAt + DISPUTE_RESOLUTION_TIMEOUT_SECONDS <= now) {
        const hash = await walletClient.writeContract({ address: manager, abi: managerAbi, functionName: "refundDisputedTimeout", args: [BigInt(id)] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "success") console.log(`Marked unresolved arbitration market ${id} refundable after timeout: ${EXPLORER}/tx/${hash}`);
        else console.error(`refundDisputedTimeout failed for market ${id}: ${hash}`);
      } else if (market.status === 3 && payoutBatchesProcessed < MAX_PAYOUT_BATCHES_PER_RUN) {
        const participantCount = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "participantCountByMarket", args: [BigInt(id)] });
        const claimCount = await publicClient.readContract({ address: manager, abi: managerAbi, functionName: "claimCountByMarket", args: [BigInt(id)] });
        if (participantCount === 0n || claimCount >= participantCount) {
          await database.query("DELETE FROM market_lifecycle_payout_progress WHERE market_id = $1", [String(id)]);
          continue;
        }

        await database.query(
          "INSERT INTO market_lifecycle_payout_progress (market_id, next_index) VALUES ($1, 0) ON CONFLICT (market_id) DO NOTHING",
          [String(id)],
        );
        const progress = await database.query<{ next_index: number }>(
          "SELECT next_index FROM market_lifecycle_payout_progress WHERE market_id = $1",
          [String(id)],
        );
        let startIndex = Number(progress.rows[0]?.next_index ?? 0);
        if (startIndex >= Number(participantCount)) {
          startIndex = 0;
          await database.query(
            "UPDATE market_lifecycle_payout_progress SET next_index = 0, updated_at = NOW() WHERE market_id = $1",
            [String(id)],
          );
        }
        const batchSize = BigInt(Math.min(Number(PAYOUT_BATCH_SIZE), Number(participantCount) - startIndex));
        const hash = await walletClient.writeContract({
          address: manager,
          abi: managerAbi,
          functionName: "distributePayouts",
          args: [BigInt(id), BigInt(startIndex), batchSize],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status !== "success") throw new Error(`distributePayouts failed for market ${id}: ${hash}`);
        await database.query(
          "UPDATE market_lifecycle_payout_progress SET next_index = $2, updated_at = NOW() WHERE market_id = $1",
          [String(id), startIndex + Number(batchSize)],
        );
        payoutBatchesProcessed++;
        nextPayoutMarketId = nextMarketCursor(id, currentCount);
        await database.query(
          "UPDATE market_lifecycle_worker_state SET next_payout_market_id = $2, updated_at = NOW() WHERE worker_key = 'enugu'",
          [nextPayoutMarketId],
        );
        console.log(`Processed payout batch for market ${id} (participants ${startIndex}-${startIndex + Number(batchSize) - 1}): ${EXPLORER}/tx/${hash}`);
      }
    }
    if (scanIds.length > 0) {
      const nextMarketId = nextMarketCursor(scanIds[scanIds.length - 1], currentCount);
      await database.query(
        "UPDATE market_lifecycle_worker_state SET next_market_id = $2, updated_at = NOW() WHERE worker_key = 'enugu'",
        [nextMarketId],
      );
    }
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [42421001]).catch(() => undefined);
    lockClient.release();
    await database.end();
  }
}

main().catch((error) => {
  console.error("Asset Oracle lifecycle automation stopped:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
