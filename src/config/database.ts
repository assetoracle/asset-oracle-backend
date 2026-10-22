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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

database.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

export async function checkDatabaseConnection(): Promise<boolean> {
  const result = await database.query("SELECT 1 AS connected");
  return result.rows[0]?.connected === 1;
}
