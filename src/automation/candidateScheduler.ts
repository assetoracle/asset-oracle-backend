import { CoinGeckoProvider } from "./coingeckoProvider.js";
import { buildPriceThresholdCandidates } from "./candidateBuilder.js";

/**
 * Starts proposal discovery on an interval only when both explicit feature flags
 * are enabled. This worker never publishes markets or submits chain transactions.
 */
export function startCandidateScheduler(): (() => void) | null {
  if (process.env.MARKET_AUTOMATION_ENABLED !== "true"
    || process.env.MARKET_AUTOMATION_SCHEDULE_ENABLED !== "true") {
    console.log("Market candidate scheduler is disabled.");
    return null;
  }

  const configured = process.env.MARKET_AUTOMATION_COINGECKO_ASSETS
    ?? (process.env.NODE_ENV === "production" ? "" : "bitcoin,ethereum");
  const assets = [...new Set(configured.split(",").map((asset) => asset.trim().toLowerCase()).filter(Boolean))];
  if (assets.length === 0 || assets.length > 20
    || assets.some((asset) => !/^[a-z0-9-]{1,80}$/.test(asset))) {
    console.error("Market candidate scheduler did not start: a valid asset allowlist is required.");
    return null;
  }

  const configuredMinutes = Number(process.env.MARKET_AUTOMATION_INTERVAL_MINUTES ?? "180");
  const intervalMinutes = Number.isFinite(configuredMinutes)
    ? Math.max(5, Math.min(1440, Math.trunc(configuredMinutes)))
    : 180;
  const provider = new CoinGeckoProvider({ apiKey: process.env.COINGECKO_API_KEY });
  let running = false;
  let stopped = false;

  const runOnce = async () => {
    if (running || stopped) return;
    running = true;
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      const { acquireAutomationRunLock } = await import("./distributedLock.js");
      releaseLock = await acquireAutomationRunLock();
      if (!releaseLock) {
        console.log("Market candidate discovery skipped: another worker holds the automation lock.");
        return;
      }
      const evidence = await provider.getUsdPrices(assets);
      const generated = buildPriceThresholdCandidates(evidence);
      const { upsertAutomationCandidates } = await import("./candidateStore.js");
      const persistence = await upsertAutomationCandidates(generated.candidates);
      console.log("Market candidate discovery completed:", JSON.stringify({
        assetsRequested: assets.length,
        evidenceReturned: evidence.length,
        candidatesGenerated: generated.candidates.length,
        candidatesInserted: persistence.inserted,
        existingCandidates: persistence.existing,
        skipped: generated.skipped.length,
      }));
    } catch (error) {
      console.error("Scheduled market candidate discovery failed:", error instanceof Error ? error.message : "Unknown error");
    } finally {
      if (releaseLock) {
        try { await releaseLock(); }
        catch (error) {
          console.error("Failed to release market automation lock:", error instanceof Error ? error.message : "Unknown error");
        }
      }
      running = false;
    }
  };

  const timer = setInterval(() => { void runOnce(); }, intervalMinutes * 60_000);
  timer.unref();
  // Run once at startup, then on the configured interval.
  void runOnce();
  console.log("Market candidate scheduler started:", JSON.stringify({
    intervalMinutes,
    assets,
    mode: "proposal-only",
  }));

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
