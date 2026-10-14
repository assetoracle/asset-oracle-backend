import { database } from "../config/database.js";

export type PointEventType = "PAID_MARKET_SUBMISSION" | "MARKET_PARTICIPATION" | "QUALIFIED_REFERRAL";
export type PointAwardInput = {
  walletAddress: string;
  eventType: PointEventType;
  eventKey: string;
  points: number;
  metadata?: Record<string, unknown>;
};
export type PointAwardResult = { awarded: boolean; points: number; totalPoints: number };

/**
 * Durable, idempotent points ledger. Callers must verify eligibility before awarding:
 * 50 for a successful qualifying paid submission, 10 for first qualifying wallet/market
 * participation, and 5 for a qualified (not pending/flagged) referral.
 */
export async function initializePointsStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_point_events (
      id BIGSERIAL PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('PAID_MARKET_SUBMISSION', 'MARKET_PARTICIPATION', 'QUALIFIED_REFERRAL')),
      event_key TEXT NOT NULL,
      points INTEGER NOT NULL CHECK (points > 0),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_type, event_key)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS leaderboard_point_events_wallet_idx
    ON leaderboard_point_events (lower(wallet_address))
  `);
}

const expectedPoints: Record<PointEventType, number> = {
  PAID_MARKET_SUBMISSION: 50,
  MARKET_PARTICIPATION: 10,
  QUALIFIED_REFERRAL: 5,
};

export async function awardLeaderboardPoints(input: PointAwardInput): Promise<PointAwardResult> {
  const walletAddress = input.walletAddress.trim().toLowerCase();
  const eventKey = input.eventKey.trim();
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) throw new Error("A valid normalized EVM wallet address is required.");
  if (!eventKey || eventKey.length > 256) throw new Error("A non-empty event key of at most 256 characters is required.");
  if (input.points !== expectedPoints[input.eventType]) throw new Error("Point value does not match the configured policy for this event type.");

  const inserted = await database.query<{ points: number }>(
    `INSERT INTO leaderboard_point_events (wallet_address, event_type, event_key, points, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (event_type, event_key) DO NOTHING
     RETURNING points`,
    [walletAddress, input.eventType, eventKey, input.points, JSON.stringify(input.metadata ?? {})],
  );
  const awarded = (inserted.rowCount ?? inserted.rows.length) > 0;
  if (!awarded) {
    const existing = await database.query<{ wallet_address: string; points: number }>(
      "SELECT wallet_address, points FROM leaderboard_point_events WHERE event_type = $1 AND event_key = $2",
      [input.eventType, eventKey],
    );
    if (!existing.rows[0]) throw new Error("Unable to confirm the idempotent points event.");
    if (existing.rows[0].wallet_address.toLowerCase() !== walletAddress || Number(existing.rows[0].points) !== input.points) {
      throw new Error("The event key is already associated with a different points award.");
    }
  }
  const total = await database.query<{ total_points: string }>(
    "SELECT COALESCE(SUM(points), 0)::text AS total_points FROM leaderboard_point_events WHERE lower(wallet_address) = $1",
    [walletAddress],
  );
  return { awarded, points: awarded ? input.points : 0, totalPoints: Number(total.rows[0]?.total_points ?? 0) };
}

export async function getPointsLeaderboard(limit = 100): Promise<Array<{ rank: number; wallet: string; points: number }>> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await database.query<{ wallet: string; points: string }>(
    `SELECT lower(wallet_address) AS wallet, SUM(points)::text AS points
     FROM leaderboard_point_events
     GROUP BY lower(wallet_address)
     ORDER BY SUM(points) DESC, lower(wallet_address) ASC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map((row, index) => ({ rank: index + 1, wallet: row.wallet, points: Number(row.points) }));
}
