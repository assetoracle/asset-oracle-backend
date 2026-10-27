import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { database } = await import("../config/database.js");
const { recordOnchainPublication } = await import("./marketStore.js");

type Row = Record<string, unknown>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>;
const db = database as unknown as { query: Query };
const originalQuery = db.query;

const proposalRow: Row = {
  id: "11111111-1111-4111-8111-111111111111",
  walletAddress: "0x1111111111111111111111111111111111111111",
  question: "Will the test pass?",
  description: "A test proposal",
  category: "Crypto",
  closesAt: "2027-01-01T00:00:00.000Z",
  resolvesAt: "2027-01-02T00:00:00.000Z",
  resolutionRule: {
    sourceId: "test",
    metric: "price",
    comparison: "ABOVE",
    targetValue: 1,
    observationTime: "2027-01-02T00:00:00.000Z",
    description: "Test rule",
  },
  status: "APPROVED",
  submittedAt: "2026-10-12T00:00:00.000Z",
  origin: "MANUAL",
  visibility: "PRIVATE",
  onchain_market_id: null,
  onchain_tx_hash: null,
  onchain_manager_address: null,
  onchain_chain_id: null,
};

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  marketId: "12",
  txHash: `0x${"a".repeat(64)}`,
  managerAddress: "0x2222222222222222222222222222222222222222",
  chainId: 42421,
};

afterEach(() => {
  db.query = originalQuery;
});

test("records verified publication metadata and returns the stored proposal", async () => {
  const published = {
    ...proposalRow,
    onchain_market_id: publication.marketId,
    onchain_tx_hash: publication.txHash,
    onchain_manager_address: publication.managerAddress.toLowerCase(),
    onchain_chain_id: publication.chainId,
    origin: "MANUAL",
    visibility: "PUBLIC",
  };
  db.query = async (sql) => {
    if (sql.includes("UPDATE market_proposals")) return { rows: [published] };
    if (sql.includes("SELECT * FROM market_proposals")) return { rows: [proposalRow] };
    throw new Error("Unexpected query in publication persistence test");
  };

  const result = await recordOnchainPublication(publication);
  assert.equal(result?.onchainMarketId, publication.marketId);
  assert.equal(result?.onchainTxHash, publication.txHash);
  assert.equal(result?.onchainChainId, publication.chainId);
  assert.equal(result?.visibility, "PUBLIC", "approved testnet publications become public");
});

test("same proposal, market ID, and transaction are idempotent", async () => {
  const published = {
    ...proposalRow,
    onchain_market_id: publication.marketId,
    onchain_tx_hash: publication.txHash,
    onchain_manager_address: publication.managerAddress.toLowerCase(),
    onchain_chain_id: publication.chainId,
  };
  let calls = 0;
  db.query = async () => {
    calls += 1;
    return { rows: [published] };
  };

  const result = await recordOnchainPublication(publication);
  assert.equal(result?.onchainTxHash, publication.txHash);
  assert.equal(calls, 1);
});

test("rejects a conflicting second publication for the same proposal", async () => {
  const existing = {
    ...proposalRow,
    onchain_market_id: publication.marketId,
    onchain_tx_hash: publication.txHash,
  };
  db.query = async () => ({ rows: [existing] });

  await assert.rejects(
    recordOnchainPublication({ ...publication, txHash: `0x${"b".repeat(64)}` }),
    /already has a recorded on-chain publication/i,
  );
});

test("converts database unique-index collisions into a publication conflict", async () => {
  db.query = async (sql) => {
    if (sql.includes("UPDATE market_proposals")) {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }
    if (sql.includes("SELECT * FROM market_proposals")) return { rows: [proposalRow] };
    throw new Error("Unexpected query in unique-index test");
  };

  await assert.rejects(
    recordOnchainPublication(publication),
    /already recorded for another proposal/i,
  );
});
