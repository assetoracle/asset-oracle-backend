import { getMarketProposal } from "./marketStore.js";
import { extractMetricValue } from "./marketEvidenceMetrics.js";
import { selectProvidersForMarket } from "./marketProviderRouter.js";
import { saveMarketEvidence, type StoredMarketEvidence } from "./marketEvidenceStore.js";
import {
  apiFootballFixtures, coingeckoCoinMarketData, dexscreenerSearch, dexscreenerTokenPairs,
  defiLlamaProtocolTvl, fredObservations, gdeltArticles, openMeteoHistorical,
  sportmonksFixturesByDate, worldBankIndicator,
} from "./dataProviders.js";

type QueryParams = {
  vsCurrency?: string; page?: number; perPage?: number; search?: string;
  chain?: string; tokenAddress?: string; protocol?: string;
  date?: string; league?: number; season?: number;
  seriesId?: string; start?: string; end?: string;
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
  let result;

  switch (selected) {
    case "coingecko":
      if (!query.coinId) throw new Error("CoinGecko evidence requires query.coinId.");
      result = await coingeckoCoinMarketData(query.coinId, query.vsCurrency);
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
      result = await fredObservations(query.seriesId, query.start, query.end);
      break;
    case "world-bank":
      if (!query.country || !query.indicator) throw new Error("World Bank evidence requires query.country and query.indicator.");
      result = await worldBankIndicator(query.country, query.indicator, query.dateRange);
      break;
    case "gdelt":
      if (!query.search) throw new Error("GDELT evidence requires query.search.");
      result = await gdeltArticles(query.search);
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
  const saved = await saveMarketEvidence({
    proposalId: proposal.id,
    provider: selected,
    sourceUrl: result.sourceUrl,
    retrievedAt: result.retrievedAt,
    contentHash: result.contentHash,
    rawData: result.data,
    metric: rule.metric,
    normalizedValue,
    verificationStatus: "UNREVIEWED",
  });
  return saved;
}
