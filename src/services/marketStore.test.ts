import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { database } = await import("../config/database.js");
const { recordOnchainPublication, decideAutomatedMarketProposal, getLatestMarketPublicationAttempt, createMarketPublicationAttempt, updateMarketPublicationAttempt } = await import("./marketStore.js");

type Row = Record<string, unknown>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
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

test("approving an automated proposal keeps it private until verified on-chain publication", async () => {
  const automated = {
    ...proposalRow,
    origin: "AUTOMATED",
    visibility: "PRIVATE",
    status: "APPROVED",
    onchain_market_id: "12",
    onchain_tx_hash: publication.txHash,
    onchain_manager_address: publication.managerAddress.toLowerCase(),
    onchain_chain_id: publication.chainId,
  };
  let capturedSql = "";
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [automated] };
  };

  const result = await decideAutomatedMarketProposal(proposalRow.id as string, "APPROVED");
  assert.match(capturedSql, /visibility = 'PRIVATE'/);
  assert.match(capturedSql, /\$2 <> 'APPROVED' OR "closesAt" > NOW\(\)/);
  assert.doesNotMatch(capturedSql, /THEN 'PUBLIC'/);
  assert.equal(result?.status, "APPROVED");
  assert.equal(result?.visibility, "PRIVATE");
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
    visibility: "PUBLIC",
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


test("loads the latest publication attempt and maps database fields", async () => {
  let capturedSql = "";
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [{
      id: 4,
      proposal_id: proposalRow.id,
      chain_id: 42421,
      manager_address: publication.managerAddress.toLowerCase(),
      attempt_number: 2,
      status: "SUBMITTED",
      transaction_hash: publication.txHash,
      market_id: null,
      failure_reason: null,
    }] };
  };
  const result = await getLatestMarketPublicationAttempt({
    proposalId: proposalRow.id as string,
    chainId: 42421,
    managerAddress: publication.managerAddress,
  });
  assert.match(capturedSql, /ORDER BY attempt_number DESC LIMIT 1/);
  assert.equal(result?.attemptNumber, 2);
  assert.equal(result?.status, "SUBMITTED");
  assert.equal(result?.transactionHash, publication.txHash);
});

test("creates a PREPARED attempt before transaction broadcast", async () => {
  let capturedSql = "";
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [{
      id: 5,
      proposal_id: proposalRow.id,
      chain_id: 42421,
      manager_address: publication.managerAddress.toLowerCase(),
      attempt_number: 3,
      status: "PREPARED",
      transaction_hash: null,
      market_id: null,
      failure_reason: null,
    }] };
  };
  const result = await createMarketPublicationAttempt({
    proposalId: proposalRow.id as string,
    chainId: 42421,
    managerAddress: publication.managerAddress,
  });
  assert.match(capturedSql, /COALESCE\(MAX\(attempt_number\), 0\) \+ 1/);
  assert.match(capturedSql, /'PREPARED'/);
  assert.equal(result.attemptNumber, 3);
  assert.equal(result.status, "PREPARED");
});

test("updates attempt state and retains the recorded transaction hash", async () => {
  let capturedValues: unknown[] = [];
  db.query = async (_sql, values) => {
    capturedValues = values ?? [];
    return { rows: [], rowCount: 1 };
  };
  await updateMarketPublicationAttempt({
    id: 5,
    status: "PUBLISHED",
    transactionHash: publication.txHash,
    marketId: "12",
  });
  assert.deepEqual(capturedValues, [5, "PUBLISHED", publication.txHash, "12", null]);
});

test("an expired automated proposal cannot be approved", async () => {
  let capturedSql = "";
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };
  const result = await decideAutomatedMarketProposal(proposalRow.id as string, "APPROVED");
  assert.equal(result, undefined);
  assert.match(capturedSql, /\$2 <> 'APPROVED' OR "closesAt" > NOW\(\)/);
});
