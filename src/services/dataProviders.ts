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
    return { provider, sourceUrl: url.toString(), retrievedAt: new Date().toISOString(), contentHash: createHash("sha256").update(body).digest("hex"), data };
  } finally {
    clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
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

export function footballMatches(competition: string, dateFrom?: string, dateTo?: string) {
  if (!/^[A-Z0-9]+$/.test(competition)) throw new Error("Invalid competition code.");
  const url = new URL(`https://api.football-data.org/v4/competitions/${competition}/matches`);
  if (dateFrom) url.searchParams.set("dateFrom", dateFrom);
  if (dateTo) url.searchParams.set("dateTo", dateTo);
  return getJson("football-data", url, { "X-Auth-Token": requiredEnv("FOOTBALL_DATA_API_KEY") });
}

export function fredObservations(seriesId: string, start?: string, end?: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(seriesId)) throw new Error("Invalid FRED series ID.");
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

export function defiLlamaProtocols() {
  return getJson("defillama", new URL("https://api.llama.fi/protocols"));
}

export function defiLlamaDexOverview() {
  return getJson("defillama", new URL("https://api.llama.fi/overview/dexs"));
}

export function assetChainRpc(method: string, params: unknown[] = [], rpcUrl = process.env.ASSET_CHAIN_RPC_URL || "https://enugu-rpc.assetchain.org") {
  if (!/^eth_[a-zA-Z0-9]+$/.test(method)) throw new Error("Invalid JSON-RPC method.");
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:") throw new Error("Asset Chain RPC must use HTTPS.");
  return getJson<{ result?: unknown; error?: { code: number; message: string } }>("asset-chain-rpc", url, { "content-type": "application/json" })
    .then(async () => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const envelope = await response.json() as { result?: unknown; error?: { code: number; message: string } };
      if (envelope.error) throw new Error(`Asset Chain RPC error ${envelope.error.code}: ${envelope.error.message}`);
      return envelope.result;
    });
}
