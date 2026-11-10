import { createHash } from "node:crypto";

export type DataSourceResult<T = unknown> = {
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  contentHash: string;
  data: T;
};

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_REQUEST_RETRIES = 1;
const GDELT_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 10_000;

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(MAX_RATE_LIMIT_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
    }
  }
  return Math.min(MAX_RATE_LIMIT_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

async function getJson<T>(provider: string, url: URL, headers: Record<string, string> = {}): Promise<DataSourceResult<T>> {
  let lastError: unknown;
  const maxRetries = provider === "gdelt" ? GDELT_RATE_LIMIT_RETRIES : PROVIDER_REQUEST_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 5000000) throw new Error(`${provider} response exceeded the 5 MB limit.`);
      if (!response.ok) {
        const retryLimit = response.status === 429 && provider === "gdelt" ? GDELT_RATE_LIMIT_RETRIES : PROVIDER_REQUEST_RETRIES;
        if ((response.status === 429 || response.status >= 500) && attempt < retryLimit) {
          const delay = response.status === 429
            ? retryDelayMs(response, attempt)
            : Math.min(MAX_RATE_LIMIT_RETRY_DELAY_MS, 750 * 2 ** attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`${provider} returned HTTP ${response.status}.`);
      }
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > 5000000) throw new Error(`${provider} response exceeded the 5 MB limit.`);
      let data: T;
      try { data = JSON.parse(body) as T; } catch { throw new Error(`${provider} returned an invalid JSON response.`); }
      const safeUrl = new URL(url);
      for (const key of [...safeUrl.searchParams.keys()]) {
        if (["api_key", "x_cg_demo_api_key", "x_cg_pro_api_key", "api_token", "token", "key"].includes(key.toLowerCase())) safeUrl.searchParams.set(key, "[REDACTED]");
      }
      return { provider, sourceUrl: safeUrl.toString(), retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update(body).digest("hex"), data };
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt >= PROVIDER_REQUEST_RETRIES) {
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
          throw new Error(`${provider} request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS / 1000} seconds per attempt; ${attempt} retry attempt(s) exhausted.`);
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${provider} request failed.`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

export function coingeckoCoinMarketData(coinId: string, vsCurrency = "usd") {
  if (!/^[a-z0-9-]{1,100}$/i.test(coinId) || !/^[a-z0-9-]{2,12}$/i.test(vsCurrency)) {
    throw new Error("Invalid CoinGecko coin ID or quote currency.");
  }
  const plan = (process.env.COINGECKO_API_PLAN || "demo").trim().toLowerCase();
  if (plan !== "demo" && plan !== "pro") throw new Error("COINGECKO_API_PLAN must be demo or pro.");
  const base = plan === "pro" ? "https://pro-api.coingecko.com/api/v3/coins/" : "https://api.coingecko.com/api/v3/coins/";
  const url = new URL(encodeURIComponent(coinId), base);
  url.searchParams.set("localization", "false");
  url.searchParams.set("tickers", "false");
  url.searchParams.set("market_data", "true");
  url.searchParams.set("community_data", "false");
  url.searchParams.set("developer_data", "false");
  url.searchParams.set("sparkline", "false");
  return getJson("coingecko", url, { [plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: requiredEnv("COINGECKO_API_KEY") });
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

export function fredObservations(seriesId: string, start?: string, end?: string, units?: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(seriesId)) throw new Error("Invalid FRED series ID.");
  if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && start > end)) throw new Error("Invalid FRED date range.");
  const supportedUnits = ["lin", "chg", "ch1", "pch", "pc1", "pca", "cch", "cca", "log"];
  if (units !== undefined && !supportedUnits.includes(units)) throw new Error("Invalid FRED observation units.");
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", requiredEnv("FRED_API_KEY"));
  url.searchParams.set("file_type", "json");
  // Return only the newest published observation, not the API's default oldest-first series.
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "1");
  if (units) url.searchParams.set("units", units);
  if (start) url.searchParams.set("observation_start", start);
  if (end) url.searchParams.set("observation_end", end);
  return getJson("fred", url);
}

export function gdeltArticles(query: string, maxRecords = 25, timespan = "24h") {
  if (!query.trim() || query.length > 250 || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 250 ||
      !/^(15min|[1-9]\d*(min|h|hours|d|days|w|weeks|m|months))$/.test(timespan) || timespan.length > 12) {
    throw new Error("Invalid GDELT query or timespan.");
  }
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query.trim());
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(maxRecords));
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("timespan", timespan);
  return getJson("gdelt", url);
}
