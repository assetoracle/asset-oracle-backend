export function objectValue(value: unknown, path: string): unknown | null {
  if (!path || path.length > 160 || !/^[a-zA-Z0-9_$.-]+$/.test(path)) return null;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? null : current;
}

/**
 * Extracts the configured metric from a provider response.
 * DeFiLlama's /tvl/{protocol} endpoint returns the TVL itself as a JSON
 * number rather than an object containing a tvl property.
 */
export function extractMetricValue(provider: string, data: unknown, metric: string): unknown | null {
  if (provider === "defillama" && metric === "tvl" && typeof data === "number" && Number.isFinite(data)) {
    return data;
  }
  return objectValue(data, metric);
}
