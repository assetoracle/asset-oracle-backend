import { createHash } from "node:crypto";
import { getMarketProposal } from "./marketStore.js";
import { extractMetricValue } from "./marketEvidenceMetrics.js";
import { selectProvidersForMarket } from "./marketProviderRouter.js";
import { saveMarketEvidence, type StoredMarketEvidence } from "./marketEvidenceStore.js";
import {
  apiFootballFixtures, coingeckoHistoricalPrice, dexscreenerSearch, dexscreenerTokenPairs,
  defiLlamaProtocolTvl, fredObservations, openMeteoHistorical,
  sportmonksFixturesByDate, worldBankIndicator, gdeltArticlesInWindow,
} from "./dataProviders.js";

type QueryParams = {
  vsCurrency?: string; page?: number; perPage?: number; search?: string; timespan?: string; maxRecords?: number;
  chain?: string; tokenAddress?: string; protocol?: string;
  date?: string; league?: number; season?: number;
  seriesId?: string; start?: string; end?: string; units?: string;
  country?: string; indicator?: string; dateRange?: string;
  latitude?: number; longitude?: number; startDate?: string; endDate?: string;
};

export async function collectMarketEvidence(proposalId: string): Promise<{
  evidence: StoredMarketEvidence;
  inserted: boolean;
}> {
  const proposal = await getMarketProposal(proposalId);
  if (!proposal) throw new Error("Market proposal not found.");
  if (proposal.status !== "APPROVED") throw new Error("Evidence can only be collected for an approved market proposal.");
  const rule = proposal.resolutionRule as typeof proposal.resolutionRule & { query?: QueryParams };
  const provider = rule.sourceId.trim().toLowerCase();
  const [selected] = selectProvidersForMarket({ category: proposal.category, sourceId: provider });
  const query = rule.query ?? {};
  const observationTime = Date.parse(rule.observationTime);
  if (!Number.isFinite(observationTime) || observationTime > Date.now()) {
    throw new Error("The configured market observation time is invalid or in the future; no recommendation can be prepared.");
  }
  let result;

  switch (selected) {
    case "coingecko":
      if (!query.coinId) throw new Error("CoinGecko evidence requires query.coinId.");
      result = await coingeckoHistoricalPrice(query.coinId, query.vsCurrency ?? "usd", rule.observationTime);
      break;
    case "dexscreener":
      if (query.tokenAddress && query.chain) result = await dexscreenerTokenPairs(query.chain, query.tokenAddress);
      else if (query.search) result = await dexscreenerSearch(query.search);
      else throw new Error("DexScreener evidence requires query.search or both query.chain and query.tokenAddress.");
      break;
    case "defillama":
      if (!query.protocol) throw new Error("DeFiLlama evidence requires query.protocol.");
      result = await defiLlamaProtocolTvl(query.protocol);
      break;
    case "sportmonks":
      if (!query.date) throw new Error("Sportmonks evidence requires query.date.");
      result = await sportmonksFixturesByDate(query.date);
      break;
    case "api-football":
      if (!query.date) throw new Error("API-Football evidence requires query.date.");
      result = await apiFootballFixtures(query.date, query.league, query.season);
      break;
    case "fred":
      if (!query.seriesId) throw new Error("FRED evidence requires query.seriesId.");
      result = await fredObservations(query.seriesId, query.start, query.end, query.units);
      break;
    case "world-bank":
      if (!query.country || !query.indicator) throw new Error("World Bank evidence requires query.country and query.indicator.");
      result = await worldBankIndicator(query.country, query.indicator, query.dateRange);
      break;
    case "gdelt":
      if (!query.search || !query.timespan) throw new Error("GDELT evidence requires query.search and query.timespan.");
      const duration = query.timespan === "15min" ? 15 * 60_000 : (() => {
        const match = /^(\d+)(min|h|hours|d|days|w|weeks|m|months)$/.exec(query.timespan!);
        if (!match) throw new Error("GDELT timespan cannot be converted to an observation window.");
        const amount = Number(match[1]);
        const unitMs: Record<string, number> = {
          min: 60_000, h: 3_600_000, hours: 3_600_000, d: 86_400_000, days: 86_400_000,
          w: 604_800_000, weeks: 604_800_000, m: 2_592_000_000, months: 2_592_000_000,
        };
        return amount * unitMs[match[2]];
      })();
      const windowEnd = new Date(observationTime).toISOString();
      const windowStart = new Date(observationTime - duration).toISOString();
      const gdeltResult = await gdeltArticlesInWindow(query.search, query.maxRecords ?? 25, windowStart, windowEnd);
      result = {
        ...gdeltResult,
        data: {
          ...gdeltResult.data,
          requested_observation_time: new Date(observationTime).toISOString(),
          observation_window_start: windowStart,
          observation_window_end: windowEnd,
        },
      };
      break;
    case "open-meteo":
      if (query.latitude === undefined || query.longitude === undefined || !query.startDate || !query.endDate) {
        throw new Error("Open-Meteo evidence requires query.latitude, query.longitude, query.startDate and query.endDate.");
      }
      result = await openMeteoHistorical(query.latitude, query.longitude, query.startDate, query.endDate);
      break;
    default:
      throw new Error("No collector is implemented for this provider.");
  }

  const normalizedValue = extractMetricValue(selected, result.data, rule.metric);
  // Version the historical observation identity so a corrected time-window
  // query never collides with a legacy evidence row containing the wrong window.
  const contentHash = selected === "coingecko" || selected === "gdelt"
    ? createHash("sha256").update(JSON.stringify({
        version: "historical-observation-v2",
        provider: selected,
        sourceUrl: result.sourceUrl,
        observationTime: new Date(observationTime).toISOString(),
        observationWindowStart: selected === "gdelt" ? new Date(
          observationTime - (() => {
            const match = /^(\\d+)(min|h|hours|d|days|w|weeks|m|months)$/.exec(query.timespan ?? "");
            if (!match) return 15 * 60_000;
            const units: Record<string, number> = {
              min: 60_000, h: 3_600_000, hours: 3_600_000, d: 86_400_000, days: 86_400_000,
              w: 604_800_000, weeks: 604_800_000, m: 2_592_000_000, months: 2_592_000_000,
            };
            return Number(match[1]) * units[match[2]];
          })(),
        ).toISOString() : null,
        responseHash: result.contentHash,
      })).digest("hex")
    : result.contentHash;
  const saved = await saveMarketEvidence({
    proposalId: proposal.id,
    provider: selected,
    sourceUrl: result.sourceUrl,
    retrievedAt: result.retrievedAt,
    contentHash,
    rawData: result.data,
    metric: rule.metric,
    normalizedValue,
    verificationStatus: "UNREVIEWED",
  });
  return saved;
}
