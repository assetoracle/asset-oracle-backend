export const MARKET_DATA_ROTATION_INTERVAL_MINUTES = 10;

export const MARKET_DATA_ROTATION = [
  {
    key: "rwa",
    label: "Real-World Assets",
    providers: ["defillama", "dexscreener", "asset-chain-indexer", "coingecko"],
  },
  {
    key: "digital-assets",
    label: "Digital Assets",
    providers: ["firescreener", "coingecko", "defillama", "dexscreener", "asset-chain-indexer"],
  },
  {
    key: "economic-financial",
    label: "Economic & Financial Data",
    providers: ["fred", "world-bank"],
  },
  {
    key: "regional-global-events",
    label: "Regional & Global Events",
    providers: ["gdelt", "open-meteo"],
  },
  {
    key: "sports",
    label: "Sports",
    providers: ["sportmonks", "api-football"],
  },
] as const;

export type MarketDataCategoryKey = (typeof MARKET_DATA_ROTATION)[number]["key"];

export type MarketDataRotationSlot = {
  category: (typeof MARKET_DATA_ROTATION)[number];
  slotIndex: number;
  cycleIndex: number;
  slotStartedAt: string;
  nextSlotAt: string;
};

/**
 * Resolve the active category from an absolute UTC time slot.
 * This is deterministic across restarts and multiple worker instances:
 * no in-memory counter or mutable database cursor is required.
 */
export function getMarketDataRotationSlot(now: Date = new Date()): MarketDataRotationSlot {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("A valid date is required to resolve the market data rotation.");
  }

  const intervalMs = MARKET_DATA_ROTATION_INTERVAL_MINUTES * 60_000;
  const absoluteSlot = Math.floor(now.getTime() / intervalMs);
  const slotIndex = ((absoluteSlot % MARKET_DATA_ROTATION.length) + MARKET_DATA_ROTATION.length) % MARKET_DATA_ROTATION.length;
  const slotStartMs = absoluteSlot * intervalMs;

  return {
    category: MARKET_DATA_ROTATION[slotIndex],
    slotIndex,
    cycleIndex: Math.floor(absoluteSlot / MARKET_DATA_ROTATION.length),
    slotStartedAt: new Date(slotStartMs).toISOString(),
    nextSlotAt: new Date(slotStartMs + intervalMs).toISOString(),
  };
}

/**
 * Filter a category's candidate providers against configured adapters.
 * Missing integrations (e.g. pending FireScreener and Asset Chain Indexer access)
 * are omitted rather than causing the entire category slot to fail.
 */
export function getConfiguredProviders(
  category: MarketDataCategoryKey,
  configuredProviders: readonly string[],
): string[] {
  const slot = MARKET_DATA_ROTATION.find((item) => item.key === category);
  if (!slot) throw new Error("Unknown market data category.");

  const configured = new Set(configuredProviders.map((provider) => provider.toLowerCase()));
  return slot.providers.filter((provider) => configured.has(provider));
}
