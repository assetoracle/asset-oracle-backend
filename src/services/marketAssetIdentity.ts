import { coingeckoCoinMarketData, defiLlamaProtocols } from "./dataProviders.js";

export type MarketAssetIdentity = { name: string; logoUrl: string } | null;

type CacheEntry = { expiresAt: number; value: MarketAssetIdentity };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const coinCache = new Map<string, CacheEntry>();
let protocolCache: { expiresAt: number; bySlug: Map<string, MarketAssetIdentity>; rows: Array<{ slug: string; name: string; identity: MarketAssetIdentity }> } | null = null;

function safeHttpsImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!["assets.coingecko.com", "coin-images.coingecko.com", "icons.llamao.fi", "icons.llama.fi"].includes(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}

async function getProtocolIndex() {
  if (protocolCache && protocolCache.expiresAt > Date.now()) return protocolCache;
  const result = await defiLlamaProtocols();
  const rows = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
  const bySlug = new Map<string, MarketAssetIdentity>();
  const indexed: Array<{ slug: string; name: string; identity: MarketAssetIdentity }> = [];
  for (const row of rows) {
    if (typeof row.slug !== "string") continue;
    const name = typeof row.name === "string" ? row.name : row.slug;
    const logoUrl = safeHttpsImage(row.logo);
    const identity = logoUrl ? { name, logoUrl } : null;
    bySlug.set(row.slug.toLowerCase(), identity);
    if (identity) indexed.push({ slug: row.slug.toLowerCase(), name, identity });
  }
  protocolCache = { bySlug, rows: indexed, expiresAt: Date.now() + CACHE_TTL_MS };
  return protocolCache;
}

function appearsAsExactPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_]+/g, "[\\s_-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(haystack);
}

/**
 * Resolve the identity of the market subject, independently of the provider
 * used to collect resolution evidence. Only provider-hosted HTTPS images are returned.
 */
export async function getMarketAssetIdentity(input: {
  coinId?: string;
  protocol?: string;
  marketText?: string;
}): Promise<MarketAssetIdentity> {
  if (input.coinId && /^[a-z0-9-]{1,100}$/i.test(input.coinId)) {
    const key = input.coinId.toLowerCase();
    const cached = coinCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const result = await coingeckoCoinMarketData(key);
      const data = result.data as Record<string, unknown>;
      const image = data.image && typeof data.image === "object" ? data.image as Record<string, unknown> : {};
      const logoUrl = safeHttpsImage(image.small) ?? safeHttpsImage(image.thumb) ?? safeHttpsImage(image.large);
      const value = logoUrl ? { name: typeof data.name === "string" ? data.name : key, logoUrl } : null;
      coinCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch { return null; }
  }

  try {
    const index = await getProtocolIndex();
    if (input.protocol && /^[a-z0-9_-]{1,100}$/i.test(input.protocol)) {
      return index.bySlug.get(input.protocol.toLowerCase()) ?? null;
    }
    const marketText = input.marketText?.trim();
    if (!marketText) return null;
    // Prefer the longest exact name/slug match to avoid matching generic short words.
    const matches = index.rows
      .filter((row) => row.name.length >= 4 && appearsAsExactPhrase(marketText, row.name))
      .sort((a, b) => b.name.length - a.name.length);
    return matches[0]?.identity ?? null;
  } catch { return null; }
}
