import { strict as assert } from "node:assert";
import test, { after, afterEach, before } from "node:test";

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ||= "postgresql://unit-test:unit-test@127.0.0.1:5432/unit_test";

const { database } = await import("../config/database.js");
const {
  claimNextGenerationCategory,
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
  assert.equal(createMarketCandidateHash("btc-usd-threshold", proposal), createMarketCandidateHash("btc-usd-threshold", later));
});

test("candidate identity changes when substantive market terms or template version change", () => {
  const changedThreshold = {
    ...proposal,
    resolutionRule: { ...proposal.resolutionRule, targetValue: 110000 },
  };
  assert.notEqual(createMarketCandidateHash("btc-usd-threshold", proposal), createMarketCandidateHash("btc-usd-threshold", changedThreshold));
  assert.notEqual(createMarketCandidateHash("btc-usd-threshold-v2", proposal), createMarketCandidateHash("btc-usd-threshold", proposal));
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
  const result = await saveMarketCandidate({ templateId: "btc-usd-threshold", proposal });
  assert.match(capturedSql, /ON CONFLICT \(proposal_hash\) DO NOTHING/);
  assert.equal(capturedValues[4], createMarketCandidateHash("btc-usd-threshold", proposal));
  assert.equal(result.inserted, true);
  assert.equal(result.candidate?.status, "PENDING_REVIEW");
});

test("duplicate candidate persistence returns inserted false without creating another row", async () => {
  db.query = async () => ({ rows: [], rowCount: 0 });
  const result = await saveMarketCandidate({ templateId: "btc-usd-threshold", proposal });
  assert.equal(result.inserted, false);
  assert.equal(result.candidate, null);
});

test("category rotation advances in the required five-category order", async () => {
  let nextIndex = 0;
  const statements: string[] = [];
  // Simulate the locked state update by deriving the new index from the UPDATE parameter.
  let stateIndex = 0;
  db.connect = async () => ({
    query: async (sql, values = []) => {
      statements.push(sql.trim());
      if (sql.includes("SELECT next_category_index")) return { rows: [{ next_category_index: stateIndex }] };
      if (sql.includes("UPDATE market_generation_state")) stateIndex = Number(values[0]);
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  });
  const categories = [];
  for (let i = 0; i < 10; i++) categories.push(await claimNextGenerationCategory());
  assert.deepEqual(categories, [
    "Digital Assets", "Economics", "Regional", "RWA", "Sports",
    "Digital Assets", "Economics", "Regional", "RWA", "Sports",
  ]);
  assert.ok(statements.filter((sql) => sql === "BEGIN").length === 10);
  assert.ok(statements.filter((sql) => sql === "COMMIT").length === 10);
});
