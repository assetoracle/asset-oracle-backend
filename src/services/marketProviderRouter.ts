export type MarketDataCategory = "Digital Assets" | "Sports" | "Economics" | "RWA" | "Regional";

export const CATEGORY_PROVIDER_ALLOWLIST: Record<MarketDataCategory, readonly string[]> = {
  "Digital Assets": ["coingecko", "dexscreener"],
  Sports: ["sportmonks", "api-football"],
  Economics: ["fred", "world-bank"],
  RWA: ["defillama", "dexscreener"],
  Regional: ["gdelt", "open-meteo"],
};

export type ProviderSelection = {
  category: MarketDataCategory;
  sourceId?: string;
};

/**
 * Returns only the providers eligible for the requested market category.
 * If a market specifies a sourceId, only that exact provider is selected.
 * This function performs no network requests; callers must invoke it for the
 * market currently being processed, never as a global fan-out.
 */
export function selectProvidersForMarket(input: ProviderSelection): string[] {
  const allowed = CATEGORY_PROVIDER_ALLOWLIST[input.category];
  if (!allowed) throw new Error("Unsupported market data category.");
  if (input.sourceId !== undefined) {
    const requested = input.sourceId.trim().toLowerCase();
    if (!allowed.includes(requested)) {
      throw new Error(`Provider "${requested}" is not approved for the ${input.category} market category.`);
    }
    return [requested];
  }
  return [...allowed];
}
