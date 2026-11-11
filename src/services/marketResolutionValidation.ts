export type ResolutionComparison = "ABOVE" | "AT_LEAST" | "BELOW" | "EQUALS";

export function evaluateResolutionRule(
  value: number,
  comparison: ResolutionComparison,
  target: number,
): "YES" | "NO" {
  const matches = comparison === "ABOVE" ? value > target
    : comparison === "AT_LEAST" ? value >= target
    : comparison === "BELOW" ? value < target
    : value === target;
  return matches ? "YES" : "NO";
}

/** Validate provider evidence against the market's configured observation timestamp. */
export function isHistoricalObservationAligned(provider: string, observationTime: string, rawData: unknown): boolean {
  if (!rawData || typeof rawData !== "object") return false;
  const data = rawData as Record<string, unknown>;
  const expected = Date.parse(observationTime);
  if (!Number.isFinite(expected)) return false;
  const normalizedProvider = provider.trim().toLowerCase();

  if (normalizedProvider === "coingecko") {
    const requested = Date.parse(String(data.requested_observation_time ?? ""));
    const observed = Date.parse(String(data.historical_observation_time ?? ""));
    return Number.isFinite(requested) && requested === expected &&
      Number.isFinite(observed) && observed <= expected && expected - observed <= 65 * 60_000;
  }
  if (normalizedProvider === "gdelt") {
    const requested = Date.parse(String(data.requested_observation_time ?? ""));
    const start = Date.parse(String(data.observation_window_start ?? ""));
    const end = Date.parse(String(data.observation_window_end ?? ""));
    return Number.isFinite(requested) && requested === expected &&
      Number.isFinite(start) && Number.isFinite(end) && start < end && end === expected;
  }
  return true;
}
