import { coingeckoCoinMarketData, defiLlamaProtocols } from "./dataProviders.js";

export type MarketAssetIdentity = { name: string; logoUrl: string } | null;

type CacheEntry = { expiresAt: number; value: MarketAssetIdentity };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const coinCache = new Map<string, CacheEntry>();
let protocolCache: { expiresAt: number; value: Map<string, MarketAssetIdentity> } | null = null;

function safeHttpsImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!["assets.coingecko.com", "coin-images.coingecko.com", "icons.llamao.fi", "icons.llama.fi"].includes(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}

export async function getMarketAssetIdentity(input: {
  sourceId?: string;
  coinId?: string;
  protocol?: string;
}): Promise<MarketAssetIdentity> {
  const source = input.sourceId?.trim().toLowerCase();
  if (source === "coingecko" && input.coinId && /^[a-z0-9-]{1,100}$/i.test(input.coinId)) {
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
    } catch {
      return null;
    }
  }
  if (source === "defillama" && input.protocol && /^[a-z0-9_-]{1,100}$/i.test(input.protocol)) {
    const key = input.protocol.toLowerCase();
    try {
      if (!protocolCache || protocolCache.expiresAt <= Date.now()) {
        const result = await defiLlamaProtocols();
        const rows = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
        const values = new Map<string, MarketAssetIdentity>();
        for (const row of rows) {
          if (typeof row.slug !== "string") continue;
          const logoUrl = safeHttpsImage(row.logo);
          if (logoUrl) values.set(row.slug.toLowerCase(), { name: typeof row.name === "string" ? row.name : row.slug, logoUrl });
        }
        protocolCache = { value: values, expiresAt: Date.now() + CACHE_TTL_MS };
      }
      return protocolCache.value.get(key) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
