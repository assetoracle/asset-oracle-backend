import "dotenv/config";
import { database } from "../config/database.js";
import { initializeMarketStore, listPublishedMarkets } from "../services/marketStore.js";
import { getMarketDataProviderCooldown, initializeMarketEvidenceStore, setMarketDataProviderCooldown } from "../services/marketEvidenceStore.js";
import { ProviderRateLimitError } from "../services/dataProviders.js";
import { collectMarketEvidence } from "../services/marketEvidenceCollector.js";
import {
  getResolutionRecommendation,
  isRecommendationAlignedWithObservationTime,
  initializeMarketResolutionVerificationStore,
  saveResolutionRecommendation,
} from "../services/marketResolutionVerification.js";

const LOCK_ID = 4242183;
const MAX_MARKETS_PER_RUN = Math.max(1, Math.min(50, Number(process.env.MARKET_RESOLUTION_MAX_PER_RUN) || 10));
const MAX_EVIDENCE_AGE_MS = Math.max(60_000, Number(process.env.MARKET_RESOLUTION_MAX_EVIDENCE_AGE_MS) || 15 * 60_000);

async function main(): Promise<void> {
  if (process.env.MARKET_RESOLUTION_VERIFICATION_WORKER_ENABLED !== "true") {
    console.log("Market resolution verification worker is disabled. No provider calls or transactions were made.");
    return;
  }
  await initializeMarketStore();
  await initializeMarketEvidenceStore();
  await initializeMarketResolutionVerificationStore();

  const lockClient = await database.connect();
  const lock = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_ID]);
  if (!lock.rows[0]?.locked) {
    lockClient.release();
    await database.end();
    console.log("Another resolution verification worker is running; exiting.");
    return;
  }

  try {
    const now = Date.now();
    const dueMarkets = (await listPublishedMarkets())
      .filter((market) => Date.parse(market.resolvesAt) <= now && market.onchainMarketId && market.onchainTxHash)
      .sort((a, b) => Date.parse(a.resolvesAt) - Date.parse(b.resolvesAt))
      .slice(0, MAX_MARKETS_PER_RUN);

    let proposed = 0;
    let skipped = 0;
    let failed = 0;
    for (const market of dueMarkets) {
      try {
        const provider = market.resolutionRule.sourceId.trim().toLowerCase();
        const existingRecommendation = await getResolutionRecommendation(market.id);
        if (existingRecommendation && await isRecommendationAlignedWithObservationTime(
          market.id, provider, market.resolutionRule.observationTime,
        )) {
          skipped++;
          continue;
        }
        if (existingRecommendation) {
          console.log(
            `Revalidating historical recommendation for market ${market.onchainMarketId}; ` +
            `stored evidence does not prove alignment with observation time ${market.resolutionRule.observationTime}.`,
          );
        }
        const cooldownUntil = await getMarketDataProviderCooldown(provider);
        if (cooldownUntil) {
          skipped++;
          console.log(`Skipping market ${market.onchainMarketId}: ${provider} is rate-limited until ${cooldownUntil}.`);
          continue;
        }
        // Only the response collected by this run may be used. Never fall back
        // to an older evidence row when a provider call did not produce a record.
        const { evidence } = await collectMarketEvidence(market.id);
        const evidenceAge = Date.now() - Date.parse(evidence.retrievedAt);
        if (!Number.isFinite(evidenceAge) || evidenceAge < 0 || evidenceAge > MAX_EVIDENCE_AGE_MS) {
          throw new Error("Provider evidence is stale or has an invalid retrieval timestamp; no recommendation was prepared.");
        }
        if (evidence.metric !== market.resolutionRule.metric) {
          throw new Error("Stored evidence metric does not match the market's configured resolution metric.");
        }
        const recommendation = await saveResolutionRecommendation({
          proposalId: market.id,
          evidence,
          comparison: market.resolutionRule.comparison,
          targetValue: market.resolutionRule.targetValue,
        });
        proposed++;
        console.log(
          `Prepared ${recommendation.proposedOutcome} recommendation for market ${market.onchainMarketId}; ` +
          `provider=${recommendation.provider}, value=${recommendation.observedValue}, evidence=${recommendation.evidenceHash}. ` +
          "Human validators must independently vote; this worker never submits votes or finalizes markets.",
        );
      } catch (error) {
        if (error instanceof ProviderRateLimitError) {
          await setMarketDataProviderCooldown("gdelt", 30, error.message);
          skipped++;
          console.warn("GDELT rate limit reached. Provider-wide cooldown set for 30 minutes; remaining GDELT markets will be skipped.");
          continue;
        }
        failed++;
        console.error(`Resolution evidence failed for market ${market.onchainMarketId}:`, error instanceof Error ? error.message : "Unknown error");
      }
    }
    console.log(`Resolution verification run: ${proposed} recommendations prepared, ${skipped} already prepared, ${failed} failed.`);
    if (failed) process.exitCode = 1;
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    lockClient.release();
    await database.end();
  }
}

main().catch(async (error) => {
  console.error("Market resolution verification worker stopped:", error instanceof Error ? error.message : "Unknown error");
  await database.end().catch(() => undefined);
  process.exitCode = 1;
});
