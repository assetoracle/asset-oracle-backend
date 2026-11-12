import "dotenv/config";
import { getAddress } from "viem";
import { database } from "../src/config/database.js";
import { ASSET_CHAIN_TESTNET_ID } from "../src/config/assetOracle.js";
import { seedLegacyMarketPublicationAttempts } from "../src/services/marketStore.js";

// Pin this one-time utility to the known Neon staging compute. This prevents a
// staging label alone from being used to run it against production.
const STAGING_DATABASE_HOST = "ep-ancient-resonance-zaescoxy.c-2.eu-west-2.aws.neon.tech";

async function main(): Promise<void> {
  const target = process.env.ASSET_ORACLE_MIGRATION_TARGET?.trim().toLowerCase();
  if (target !== "staging") {
    throw new Error("Set ASSET_ORACLE_MIGRATION_TARGET=staging. This utility is intentionally restricted to the staging branch.");
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  let databaseHost: string;
  try {
    databaseHost = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (databaseHost !== STAGING_DATABASE_HOST) {
    throw new Error("DATABASE_URL does not point to the pinned Neon staging compute. No seed was written.");
  }

  const rawManager = process.env.ASSET_ORACLE_MARKET_MANAGER_ADDRESS?.trim();
  if (!rawManager || !/^0x[0-9a-fA-F]{40}$/.test(rawManager)) {
    throw new Error("ASSET_ORACLE_MARKET_MANAGER_ADDRESS must be the verified Enugu testnet market manager address.");
  }
  const managerAddress = getAddress(rawManager);
  const configuredChainId = Number(process.env.ASSET_CHAIN_ID);
  if (configuredChainId !== ASSET_CHAIN_TESTNET_ID) {
    throw new Error(`Set ASSET_CHAIN_ID=${ASSET_CHAIN_TESTNET_ID}; refusing to seed another chain.`);
  }

  const apply = process.argv.includes("--apply");
  const databaseInfo = await database.query<{ database_name: string; role_name: string }>(
    "SELECT current_database() AS database_name, current_user AS role_name",
  );
  const tables = await database.query<{ attempts: string | null; migrations: string | null; proposals: string | null }>(
    "SELECT to_regclass('public.market_publish_attempts') AS attempts, to_regclass('public.market_store_migrations') AS migrations, to_regclass('public.market_proposals') AS proposals",
  );
  const present = tables.rows[0];
  if (!present?.attempts || !present.migrations || !present.proposals) {
    throw new Error("Required market publication tables are missing. Start the API against staging first to apply its additive schema migration; no seed was written.");
  }

  const migrationKey = `legacy_market_publication_attempts_${ASSET_CHAIN_TESTNET_ID}_${managerAddress.toLowerCase()}`;
  const [candidateResult, markerResult] = await Promise.all([
    database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM market_proposals
        WHERE status = 'APPROVED'
          AND onchain_tx_hash IS NULL
          AND onchain_market_id IS NULL`,
    ),
    database.query<{ applied_at: string }>(
      "SELECT applied_at FROM market_store_migrations WHERE migration_key = $1",
      [migrationKey],
    ),
  ]);

  console.log("Asset Oracle legacy publication reconciliation seed");
  console.log(`Target label: ${target}`);
  console.log(`Database host: ${databaseHost}`);
  console.log(`Database: ${databaseInfo.rows[0]?.database_name ?? "unknown"}`);
  console.log(`Database role: ${databaseInfo.rows[0]?.role_name ?? "unknown"}`);
  console.log(`Chain: ${ASSET_CHAIN_TESTNET_ID}`);
  console.log(`Manager: ${managerAddress}`);
  console.log(`Approved unpublished proposals eligible for conservative reconciliation: ${candidateResult.rows[0]?.count ?? "0"}`);
  console.log(`One-time seed marker already exists: ${markerResult.rows.length > 0 ? "yes" : "no"}`);

  if (!apply) {
    console.log("DRY RUN ONLY. No database rows were changed. Re-run with --apply to write RECONCILIATION_REQUIRED records.");
    return;
  }

  const seeded = await seedLegacyMarketPublicationAttempts({
    chainId: ASSET_CHAIN_TESTNET_ID,
    managerAddress,
  });
  const verification = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM market_publish_attempts
      WHERE chain_id = $1
        AND manager_address = lower($2)
        AND status = 'RECONCILIATION_REQUIRED'`,
    [ASSET_CHAIN_TESTNET_ID, managerAddress],
  );
  console.log(`New legacy attempts seeded: ${seeded}`);
  console.log(`RECONCILIATION_REQUIRED attempts for this chain and manager: ${verification.rows[0]?.count ?? "0"}`);
  console.log("No wallet, RPC client, or lifecycle worker was started. No blockchain transaction was submitted.");
}

main()
  .catch((error) => {
    console.error("Legacy publication seed stopped:", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.end();
  });
