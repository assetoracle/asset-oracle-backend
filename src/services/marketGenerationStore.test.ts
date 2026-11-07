import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ||= "postgresql://unit-test:unit-test@127.0.0.1:5432/unit_test";

const { database } = await import("../config/database.js");
const {
  generateWithinNextCategory,
  createMarketCandidateHash,
  saveMarketCandidate,
} = await import("./marketGenerationStore.js");

if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[]; rowCount?: number };
type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;
const db = database as unknown as {
  query: Query;
  connect: () => Promise<{ query: Query; release: () => void }>;
};
const originalQuery = db.query;
const originalConnect = db.connect;

const proposal = {
  question: "Will Bitcoin trade above 100000 USD?",
  description: "This candidate resolves using the configured CoinGecko market data at the observation time.",
  category: "Digital Assets" as const,
  closesAt: "2027-01-01T01:00:00.000Z",
  resolvesAt: "2027-01-01T02:00:00.000Z",
  resolutionRule: {
    sourceId: "coingecko",
    metric: "market_data.current_price.usd",
    comparison: "ABOVE" as const,
    targetValue: 100000,
    currency: "USD",
    observationTime: "2027-01-01T00:00:00.000Z",
    description: "Resolve using the CoinGecko current USD price at the observation time.",
    query: { coinId: "bitcoin", vsCurrency: "usd" },
  },
};

afterEach(() => {
  db.query = originalQuery;
  db.connect = originalConnect;
});

test("candidate identity remains stable when runtime timestamps change", () => {
  const later = {
    ...proposal,
    closesAt: "2027-01-02T01:00:00.000Z",
    resolvesAt: "2027-01-02T02:00:00.000Z",
    resolutionRule: {
      ...proposal.resolutionRule,
      observationTime: "2027-01-02T00:00:00.000Z",
      query: { vsCurrency: "usd", coinId: "bitcoin" },
    },
  };
  assert.equal(createMarketCandidateHash(proposal, { closeAfterMinutes: 60, resolveAfterMinutes: 120 }), createMarketCandidateHash(later, { closeAfterMinutes: 60, resolveAfterMinutes: 120 }));
});

test("candidate identity changes when substantive market terms or schedule change", () => {
  const changedThreshold = {
    ...proposal,
    resolutionRule: { ...proposal.resolutionRule, targetValue: 110000 },
  };
  assert.notEqual(createMarketCandidateHash(proposal, { closeAfterMinutes: 60, resolveAfterMinutes: 120 }), createMarketCandidateHash(changedThreshold, { closeAfterMinutes: 60, resolveAfterMinutes: 120 }));
  assert.notEqual(createMarketCandidateHash(proposal, { closeAfterMinutes: 60, resolveAfterMinutes: 120 }), createMarketCandidateHash(proposal, { closeAfterMinutes: 90, resolveAfterMinutes: 180 }));
});

test("candidate persistence inserts using a stable unique hash", async () => {
  let capturedSql = "";
  let capturedValues: unknown[] = [];
  db.query = async (sql, values = []) => {
    capturedSql = sql;
    capturedValues = values;
    return {
      rows: [{
        id: "11111111-1111-4111-8111-111111111111",
        template_id: "btc-usd-threshold",
        category: "Digital Assets",
        proposal,
        status: "PENDING_REVIEW",
        created_at: "2027-01-01T00:00:00.000Z",
      }],
      rowCount: 1,
    };
  };
  const result = await saveMarketCandidate({ templateId: "btc-usd-threshold", proposal, closeAfterMinutes: 60, resolveAfterMinutes: 120 });
  assert.match(capturedSql, /ON CONFLICT \(proposal_hash\) WHERE status <> 'EXPIRED' DO NOTHING/);
  assert.equal(capturedValues[4], createMarketCandidateHash(proposal, { closeAfterMinutes: 60, resolveAfterMinutes: 120 }));
  assert.equal(result.inserted, true);
  assert.equal(result.candidate?.status, "PENDING_REVIEW");
});

test("duplicate candidate persistence returns inserted false without creating another row", async () => {
  db.query = async () => ({ rows: [], rowCount: 0 });
  const result = await saveMarketCandidate({ templateId: "btc-usd-threshold", proposal, closeAfterMinutes: 60, resolveAfterMinutes: 120 });
  assert.equal(result.inserted, false);
  assert.equal(result.candidate, null);
});

test("category cursor advances only after the candidate batch succeeds", async () => {
  let stateIndex = 0;
  const statements: string[] = [];
  db.connect = async () => ({
    query: async (sql, values = []) => {
      statements.push(sql.trim());
      if (sql.includes("SELECT next_category_index")) return { rows: [{ next_category_index: stateIndex }] };
      if (sql.includes("UPDATE market_generation_state")) stateIndex = Number(values[0]);
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  });

  const first = await generateWithinNextCategory(async (category) => {
    assert.equal(category, "Digital Assets");
    assert.equal(stateIndex, 0, "cursor must not advance before the batch work completes");
    return "saved";
  });
  assert.equal(first.category, "Digital Assets");
  assert.equal(first.result, "saved");
  assert.equal(stateIndex, 1);
  assert.ok(statements.includes("COMMIT"));
});

test("failed candidate batch rolls back and preserves the category cursor", async () => {
  let stateIndex = 2;
  const statements: string[] = [];
  db.connect = async () => ({
    query: async (sql, values = []) => {
      statements.push(sql.trim());
      if (sql.includes("SELECT next_category_index")) return { rows: [{ next_category_index: stateIndex }] };
      if (sql.includes("UPDATE market_generation_state")) stateIndex = Number(values[0]);
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  });

  await assert.rejects(
    generateWithinNextCategory(async (category) => {
      assert.equal(category, "Regional");
      throw new Error("simulated candidate persistence failure");
    }),
    /simulated candidate persistence failure/,
  );
  assert.equal(stateIndex, 2);
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(statements.some((sql) => sql.includes("UPDATE market_generation_state")), false);
  assert.equal(statements.includes("COMMIT"), false);
});

test("candidate promotion atomically creates a private PENDING_APPROVAL proposal", async () => {
  const candidateId = "22222222-2222-4222-8222-222222222222";
  const statements: string[] = [];
  let insertedProposalSql = "";
  db.connect = async () => ({
    query: async (sql, values = []) => {
      statements.push(sql.trim());
      if (sql.includes("FROM market_generation_candidates WHERE id=$1 FOR UPDATE")) {
        return {
          rows: [{
            id: candidateId,
            template_id: "btc-usd-threshold",
            category: "Digital Assets",
            proposal,
            status: "PENDING_REVIEW",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO market_proposals")) {
        insertedProposalSql = sql;
        return {
          rows: [{
            id: "33333333-3333-4333-8333-333333333333",
            walletAddress: null,
            question: proposal.question,
            description: proposal.description,
            category: proposal.category,
            closesAt: proposal.closesAt,
            resolvesAt: proposal.resolvesAt,
            resolutionRule: proposal.resolutionRule,
            status: "PENDING_APPROVAL",
            submittedAt: "2027-01-01T00:00:00.000Z",
            origin: "AUTOMATED",
            visibility: "PRIVATE",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE market_generation_candidates")) return { rows: [{ id: candidateId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  });
  const { reviewMarketCandidate } = await import("./marketGenerationStore.js");
  const result = await reviewMarketCandidate({
    candidateId,
    decision: "PROMOTED",
    reviewerAddress: "0x1111111111111111111111111111111111111111",
  });
  assert.match(insertedProposalSql, /'PENDING_APPROVAL', 'AUTOMATED', 'PRIVATE'/);
  assert.equal(result.result, "UPDATED");
  assert.equal(result.proposal?.status, "PENDING_APPROVAL");
  assert.equal(result.proposal?.origin, "AUTOMATED");
  assert.equal(result.proposal?.visibility, "PRIVATE");
  assert.ok(statements.includes("BEGIN"));
  assert.ok(statements.includes("COMMIT"));
});
