import "dotenv/config";
import { database } from "../config/database.js";
import { initializeMarketGenerationStore } from "../services/marketGenerationStore.js";
import { generateNextMarketCandidate } from "../services/marketProposalGenerator.js";

const LOCK_ID = 4242183;

async function main(): Promise<void> {
  if (process.env.MARKET_PROPOSAL_GENERATOR_ENABLED !== "true") {
    console.log("Market proposal generator is disabled.");
    return;
  }
  await initializeMarketGenerationStore();
  const client = await database.connect();
  const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_ID]);
  if (!lock.rows[0]?.locked) {
    client.release();
    await database.end();
    console.log("Another proposal generator is running; exiting.");
    return;
  }
  try {
    const result = await generateNextMarketCandidate();
    console.log("Market proposal generation complete:", result);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
    await database.end();
  }
}

main().catch(async (error) => {
  console.error("Market proposal generator failed:", error instanceof Error ? error.message : "Unknown error");
  await database.end().catch(() => undefined);
  process.exitCode = 1;
});
