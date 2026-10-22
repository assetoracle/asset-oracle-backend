import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured.");
}

const databaseUrl = new URL(process.env.DATABASE_URL);
const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname);

export const database = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Local isolated test databases commonly run without TLS; keep certificate
  // verification enabled for every non-local database.
  ssl: isLocalDatabase ? false : { rejectUnauthorized: true },
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