import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { database } = await import("../config/database.js");
const { awardLeaderboardPoints, getPointsLeaderboard, initializePointsStore } = await import("./pointsStore.js");

type Row = Record<string, unknown>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
const db = database as unknown as { query: Query };
const originalQuery = db.query;

afterEach(() => { db.query = originalQuery; });

test("initializes a durable ledger with unique event keys", async () => {
  const sqls: string[] = [];
  db.query = async (sql) => { sqls.push(sql); return { rows: [], rowCount: 0 }; };
  await initializePointsStore();
  assert.equal(sqls.length, 2);
  assert.match(sqls[0], /UNIQUE \(event_type, event_key\)/);
  assert.match(sqls[0], /CHECK \(points > 0\)/);
});

test("awards the policy amount and reports current total", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  db.query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("INSERT INTO leaderboard_point_events")) return { rows: [{ points: 50 }], rowCount: 1 };
    if (sql.includes("SUM(points)")) return { rows: [{ total_points: "50" }], rowCount: 1 };
    throw new Error("Unexpected query");
  };
  const result = await awardLeaderboardPoints({
    walletAddress: "0x1111111111111111111111111111111111111111",
    eventType: "PAID_MARKET_SUBMISSION",
    eventKey: "proposal:abc",
    points: 50,
  });
  assert.deepEqual(result, { awarded: true, points: 50, totalPoints: 50 });
  assert.equal(calls[0].values?.[0], "0x1111111111111111111111111111111111111111");
});

test("retries do not award duplicate points", async () => {
  db.query = async (sql) => {
    if (sql.includes("INSERT INTO leaderboard_point_events")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT wallet_address, points")) return { rows: [{ wallet_address: "0x1111111111111111111111111111111111111111", points: 10 }], rowCount: 1 };
    if (sql.includes("SUM(points)")) return { rows: [{ total_points: "10" }], rowCount: 1 };
    throw new Error("Unexpected query");
  };
  const result = await awardLeaderboardPoints({
    walletAddress: "0x1111111111111111111111111111111111111111",
    eventType: "MARKET_PARTICIPATION",
    eventKey: "market:12:wallet:0x1111111111111111111111111111111111111111",
    points: 10,
  });
  assert.deepEqual(result, { awarded: false, points: 0, totalPoints: 10 });
});

test("rejects incorrect policy values and conflicting event-key reuse", async () => {
  await assert.rejects(awardLeaderboardPoints({
    walletAddress: "0x1111111111111111111111111111111111111111",
    eventType: "QUALIFIED_REFERRAL",
    eventKey: "referral:abc",
    points: 50,
  }), /does not match the configured policy/);

  db.query = async (sql) => {
    if (sql.includes("INSERT INTO leaderboard_point_events")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT wallet_address, points")) return { rows: [{ wallet_address: "0x2222222222222222222222222222222222222222", points: 5 }], rowCount: 1 };
    throw new Error("Unexpected query");
  };
  await assert.rejects(awardLeaderboardPoints({
    walletAddress: "0x1111111111111111111111111111111111111111",
    eventType: "QUALIFIED_REFERRAL",
    eventKey: "referral:abc",
    points: 5,
  }), /already associated with a different points award/);
});

test("leaderboard sorts by points and caps results", async () => {
  let limitValue: unknown;
  db.query = async (_sql, values) => {
    limitValue = values?.[0];
    return { rows: [
      { wallet: "0x1111111111111111111111111111111111111111", points: "60" },
      { wallet: "0x2222222222222222222222222222222222222222", points: "50" },
    ], rowCount: 2 };
  };
  const result = await getPointsLeaderboard(1000);
  assert.equal(limitValue, 100);
  assert.deepEqual(result.map((entry) => entry.rank), [1, 2]);
  assert.deepEqual(result.map((entry) => entry.points), [60, 50]);
});
