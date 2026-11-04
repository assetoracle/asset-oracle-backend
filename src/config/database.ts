import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured.");
}

// Keep certificate verification enabled by default. Disabling verification is
// only acceptable for an isolated test service using a trusted/private network;
// never set DATABASE_SSL_REJECT_UNAUTHORIZED=false on production.
const rejectUnauthorized =
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";

export const database = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized,
  },
  max: Math.min(10, Math.max(1, Number(process.env.DB_POOL_MAX) || 10)),
  idleTimeoutMillis: 10000,
  // Allow time for a suspended Neon Free compute to resume before failing a request.
  connectionTimeoutMillis: Math.min(60000, Math.max(1000, Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 20000)),
  // Prevent an individual SQL statement from holding a pooled connection indefinitely.
  statement_timeout: Math.min(60000, Math.max(1000, Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 20000)),
});

database.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

export async function checkDatabaseConnection(): Promise<boolean> {
  const result = await database.query("SELECT 1 AS connected");
  return result.rows[0]?.connected === 1;
}
