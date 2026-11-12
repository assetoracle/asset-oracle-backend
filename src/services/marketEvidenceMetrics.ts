const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export function objectValue(value: unknown, path: string): unknown | null {
  if (!path || path.length > 160 || !/^[a-zA-Z0-9_$.-]+$/.test(path)) return null;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (FORBIDDEN_PATH_PARTS.has(part) || current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? null : current;
}

/** Conservative GDELT relevance check: every market term must appear in the article title. */
export function filterGdeltArticlesByRequiredTerms<T extends { title?: string }>(
  articles: T[],
  requiredTerms: string[],
): T[] {
  const terms = requiredTerms.map((term) => term.trim().toLocaleLowerCase("en"));
  if (terms.length < 2 || terms.some((term) => term.length < 2) || new Set(terms).size !== terms.length) {
    throw new Error("GDELT relevance screening requires at least two unique, non-empty market terms.");
  }
  return articles.filter((article) => {
    const title = typeof article.title === "string" ? article.title.toLocaleLowerCase("en") : "";
    return title.length > 0 && terms.every((term) => title.includes(term));
  });
}

/** Provider metric contract shared by proposal validation and evidence extraction. */
export function isSupportedMetric(provider: string, metric: string): boolean {
  const fixed: Record<string, string[]> = {
    coingecko: ["price_usd", "BTC/USD"],
    defillama: ["tvl"],
    gdelt: ["articles.length"],
    fred: ["observations.0.value"],
    "world-bank": ["1.0.value"],
    "api-football": ["response.length"],
    sportmonks: ["data.length"],
    "open-meteo": [
      "daily.temperature_2m_max", "daily.temperature_2m_min",
      "daily.precipitation_sum", "daily.weather_code",
    ],
  };
  if (fixed[provider]?.includes(metric)) return true;
  if (provider === "coingecko") return /^market_data\.current_price\.[a-z0-9-]{2,12}$/i.test(metric);
  // DexScreener returns either a pair array or a search object. Require a
  // concrete, bounded JSON path rather than accepting arbitrary expressions.
  if (provider === "dexscreener") return /^(pairs|schemaVersion|pair|priceUsd|liquidity\.usd|volume\.h24|priceChange\.h24)$/.test(metric);
  return false;
}

/**
 * Extract a scalar metric from the provider's documented response shape.
 * Aliases are retained for existing approved markets while new proposals use
 * the explicit provider response path.
 */
export function extractMetricValue(provider: string, data: unknown, metric: string): unknown | null {
  if (provider === "coingecko" && metric === "BTC/USD") {
    return objectValue(data, "market_data.current_price.usd");
  }
  if (provider === "coingecko" && metric === "price_usd") {
    return objectValue(data, "market_data.current_price.usd");
  }
  if (provider === "defillama" && metric === "tvl") {
    return typeof data === "number" && Number.isFinite(data) ? data : null;
  }
  if (provider === "gdelt" && metric === "articles.length") {
    const relevantArticles = objectValue(data, "relevant_articles");
    return Array.isArray(relevantArticles) ? relevantArticles.length : null;
  }
  if (provider === "api-football" && metric === "response.length") {
    const response = objectValue(data, "response");
    return Array.isArray(response) ? response.length : null;
  }
  if (provider === "sportmonks" && metric === "data.length") {
    const fixtures = objectValue(data, "data");
    return Array.isArray(fixtures) ? fixtures.length : null;
  }
  return objectValue(data, metric);
}
