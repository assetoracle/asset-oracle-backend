import type { PoolClient } from "pg";

/**
 * Acquires a session-scoped PostgreSQL advisory lock so only one backend
 * instance executes a scheduled automation pass at a time. The client must
 * remain checked out until release() is called because advisory locks are
 * scoped to the PostgreSQL session.
 */
export async function acquireAutomationRunLock(): Promise<(() => Promise<void>) | null> {
  const { database } = await import("../config/database.js");
  const client: PoolClient = await database.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [0x41534f, 1],
    );
    if (result.rows[0]?.acquired !== true) {
      client.release();
      return null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [0x41534f, 1]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}
