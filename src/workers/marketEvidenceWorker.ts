import "dotenv/config";
import { database } from "../config/database.js";
import { initializeMarketStore, listApprovedMarketProposalsForEvidence } from "../services/marketStore.js";
import { selectEvidenceEligibleProposals } from "./marketEvidencePolicy.js";
import {
  initializeMarketEvidenceStore,
  getLatestMarketEvidenceAttemptAt,
  recordMarketEvidenceAttempt,
} from "../services/marketEvidenceStore.js";
import { collectMarketEvidence } from "../services/marketEvidenceCollector.js";

const LOCK_ID = 4242182;
const MAX_MARKETS_PER_RUN = Math.max(1, Math.min(50, Number(process.env.MARKET_EVIDENCE_MAX_PER_RUN) || 10));
const DEFAULT_INTERVAL_MINUTES = Math.max(1, Number(process.env.MARKET_EVIDENCE_INTERVAL_MINUTES) || 15);
const CATEGORY_ENV: Record<string, string> = {
  "Digital Assets": "MARKET_EVIDENCE_DIGITAL_ASSETS_INTERVAL_MINUTES",
  RWA: "MARKET_EVIDENCE_RWA_INTERVAL_MINUTES",
  Sports: "MARKET_EVIDENCE_SPORTS_INTERVAL_MINUTES",
  Economics: "MARKET_EVIDENCE_ECONOMICS_INTERVAL_MINUTES",
  Regional: "MARKET_EVIDENCE_REGIONAL_INTERVAL_MINUTES",
};

function intervalFor(category: string): number {
  const key = CATEGORY_ENV[category];
  const configured = key ? Number(process.env[key] ?? (category === "Digital Assets" ? process.env.MARKET_EVIDENCE_CRYPTO_INTERVAL_MINUTES : undefined)) : NaN;
  return Math.max(1, Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MINUTES);
}

async function main(): Promise<void> {
  if (process.env.MARKET_EVIDENCE_WORKER_ENABLED !== "true") {
    console.log("Market evidence worker is disabled. Set MARKET_EVIDENCE_WORKER_ENABLED=true only when scheduling is intentionally enabled.");
    return;
  }

  await initializeMarketStore();
  await initializeMarketEvidenceStore();
  const lockClient = await database.connect();
  const lockResult = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_ID]);
  if (!lockResult.rows[0]?.locked) {
    lockClient.release();
    await database.end();
    console.log("Another market evidence worker is running; exiting.");
    return;
  }

  try {
    const proposals = selectEvidenceEligibleProposals(await listApprovedMarketProposalsForEvidence());

    let collected = 0;
    let skippedFresh = 0;
    let failed = 0;
    let considered = 0;
    for (const proposal of proposals) {
      if (considered >= MAX_MARKETS_PER_RUN) break;
      const provider = proposal.resolutionRule.sourceId.trim().toLowerCase();
      const latestAttempt = await getLatestMarketEvidenceAttemptAt(proposal.id, provider);
      const intervalMs = intervalFor(proposal.category) * 60_000;
      if (latestAttempt && Date.now() - Date.parse(latestAttempt) < intervalMs) {
        skippedFresh++;
        continue;
      }
      considered++;
      try {
        await recordMarketEvidenceAttempt(proposal.id, provider);
        const result = await collectMarketEvidence(proposal.id);
        if (result.inserted) collected++;
        console.log(`Evidence ${result.inserted ? "stored" : "unchanged"} for proposal ${proposal.id} using ${provider}.`);
      } catch (error) {
        failed++;
        console.error(`Evidence collection failed for proposal ${proposal.id} (${provider}):`, error instanceof Error ? error.message : "Unknown error");
      }
    }
    console.log(`Market evidence run complete: ${collected} new, ${skippedFresh} fresh/skipped, ${failed} failed, ${considered} attempted; approved manual and automated proposals with future resolution times considered.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    lockClient.release();
    await database.end();
  }
}

main().catch(async (error) => {
  console.error("Market evidence worker stopped:", error instanceof Error ? error.message : "Unknown error");
  await database.end().catch(() => undefined);
  process.exitCode = 1;
});
