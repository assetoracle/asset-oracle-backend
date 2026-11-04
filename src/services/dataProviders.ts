import { createHash } from "node:crypto";

export type DataSourceResult<T = unknown> = {
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  contentHash: string;
  data: T;
};

async function getJson<T>(provider: string, url: URL, headers: Record<string, string> = {}): Promise<DataSourceResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    const data = JSON.parse(body) as T;
    const safeUrl = new URL(url);
    for (const key of ["api_key", "x_cg_demo_api_key", "x_cg_pro_api_key", "api_token", "token", "key"]) {
      if (safeUrl.searchParams.has(key)) safeUrl.searchParams.set(key, "[REDACTED]");
    }
    return { provider, sourceUrl: safeUrl.toString(), retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update(body).digest("hex"), data };
  } finally {
    clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function dexscreenerSearch(query: string) {
  if (!query.trim() || query.length > 120) throw new Error("Invalid token search query.");
  const url = new URL("https://api.dexscreener.com/latest/dex/search");
  url.searchParams.set("q", query.trim());
  return getJson("dexscreener", url);
}

export function dexscreenerTokenPairs(chain: string, address: string) {
  if (!/^[a-z0-9-]+$/i.test(chain) || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid chain or token address.");
  return getJson("dexscreener", new URL(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${address}`));
}

export function defiLlamaProtocolTvl(slug: string) {
  if (!/^[a-z0-9_-]+$/i.test(slug)) throw new Error("Invalid protocol slug.");
  return getJson("defillama", new URL(`https://api.llama.fi/tvl/${encodeURIComponent(slug)}`));
}

export function defiLlamaHistoricalChainTvl(chain: string) {
  if (!/^[a-z0-9 _-]+$/i.test(chain)) throw new Error("Invalid chain name.");
  return getJson("defillama", new URL(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`));
}

export function defiLlamaProtocols() {
  return getJson("defillama", new URL("https://api.llama.fi/protocols"));
}

export function defiLlamaDexOverview() {
  return getJson("defillama", new URL("https://api.llama.fi/overview/dexs"));
}

export function coingeckoMarkets(vsCurrency = "usd", page = 1, perPage = 100) {
  if (!/^[a-z0-9-]{2,12}$/i.test(vsCurrency) || !Number.isInteger(page) || page < 1 || page > 1000 ||
      !Number.isInteger(perPage) || perPage < 1 || perPage > 250) throw new Error("Invalid CoinGecko market query.");
  const plan = (process.env.COINGECKO_API_PLAN || "demo").trim().toLowerCase();
  if (plan !== "demo" && plan !== "pro") throw new Error("COINGECKO_API_PLAN must be demo or pro.");
  const url = new URL(plan === "pro" ? "https://pro-api.coingecko.com/api/v3/coins/markets" : "https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", vsCurrency.toLowerCase());
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sparkline", "false");
  return getJson("coingecko", url, { [plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: requiredEnv("COINGECKO_API_KEY") });
}

export function worldBankIndicator(country: string, indicator: string, dateRange?: string) {
  if (!/^[A-Z]{2,3}$/i.test(country) || !/^[A-Z0-9._-]+$/i.test(indicator) ||
      (dateRange && !/^\d{4}:\d{4}$/.test(dateRange))) throw new Error("Invalid World Bank country or indicator query.");
  const url = new URL(`https://api.worldbank.org/v2/country/${country.toUpperCase()}/indicator/${encodeURIComponent(indicator)}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("per_page", "100");
  if (dateRange) url.searchParams.set("date", dateRange);
  return getJson("world-bank", url);
}

export function openMeteoHistorical(latitude: number, longitude: number, startDate: string, endDate: string) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw new Error("Invalid Open-Meteo coordinates or date range.");
  }
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum");
  url.searchParams.set("timezone", "UTC");
  return getJson("open-meteo", url);
}

export function sportmonksFixturesByDate(date: string) {
  if (!validDate(date)) throw new Error("Invalid Sportmonks fixture date.");
  const url = new URL(`https://api.sportmonks.com/v3/football/fixtures/date/${date}`);
  return getJson("sportmonks", url, { Authorization: requiredEnv("SPORTMONKS_API_TOKEN") });
}

export function apiFootballFixtures(date: string, league?: number, season?: number) {
  if (!validDate(date) || (league !== undefined && (!Number.isInteger(league) || league < 1)) ||
      (season !== undefined && (!Number.isInteger(season) || season < 1900 || season > 2200))) {
    throw new Error("Invalid API-Football fixture query.");
  }
  const url = new URL("https://v3.football.api-sports.io/fixtures");
  url.searchParams.set("date", date);
  if (league !== undefined) url.searchParams.set("league", String(league));
  if (season !== undefined) url.searchParams.set("season", String(season));
  return getJson("api-football", url, { "x-apisports-key": requiredEnv("API_FOOTBALL_API_KEY") });
}

export function fredObservations(seriesId: string, start?: string, end?: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(seriesId)) throw new Error("Invalid FRED series ID.");
  if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && start > end)) throw new Error("Invalid FRED date range.");
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", requiredEnv("FRED_API_KEY"));
  url.searchParams.set("file_type", "json");
  if (start) url.searchParams.set("observation_start", start);
  if (end) url.searchParams.set("observation_end", end);
  return getJson("fred", url);
}

export function gdeltArticles(query: string, maxRecords = 25) {
  if (!query.trim() || query.length > 250 || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 250) throw new Error("Invalid GDELT query.");
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query.trim());
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(maxRecords));
  url.searchParams.set("sort", "DateDesc");
  return getJson("gdelt", url);
}
