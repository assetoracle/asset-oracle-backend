import type { ProviderEvidence } from "./types.js";

export type CoinGeckoProviderOptions = {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
};

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

const DEFAULT_BASE_URL = "https://api.coingecko.com/api/v3";
const MAX_RESPONSE_AGE_MS = 15 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && value.trim() !== ""
    ? seconds * 1000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(Math.floor(delay), MAX_RETRY_DELAY_MS);
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class CoinGeckoProvider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;

  constructor(options: CoinGeckoProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxRetries = Math.max(0, Math.min(Math.trunc(options.maxRetries ?? 2), 3));
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async getUsdPrices(assetIds: string[]): Promise<ProviderEvidence[]> {
    const ids = [...new Set(assetIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (ids.length === 0) return [];
    if (ids.some((id) => !/^[a-z0-9-]{1,80}$/.test(id))) {
      throw new ProviderRequestError("Invalid CoinGecko asset ID.", false);
    }

    const url = new URL(this.baseUrl + "/simple/price");
    url.searchParams.set("ids", ids.join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_last_updated_at", "true");

    let body: unknown;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (this.apiKey) headers["x-cg-demo-api-key"] = this.apiKey;
        const response = await this.fetchImpl(url, {
          method: "GET", headers, signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new ProviderRequestError(
            "CoinGecko returned HTTP " + response.status + ".",
            retryable,
            retryAfterMilliseconds(response.headers.get("retry-after")),
          );
          if (!retryable || attempt >= this.maxRetries) throw error;
          await this.sleepImpl(error.retryAfterMs ?? Math.min(250 * (2 ** attempt), MAX_RETRY_DELAY_MS));
          continue;
        }
        try {
          body = await response.json();
        } catch {
          throw new ProviderRequestError("CoinGecko returned invalid JSON.", true);
        }
        break;
      } catch (error) {
        if (error instanceof ProviderRequestError) {
          if (!error.retryable || attempt >= this.maxRetries) throw error;
          await this.sleepImpl(error.retryAfterMs ?? Math.min(250 * (2 ** attempt), MAX_RETRY_DELAY_MS));
          continue;
        }
        if (attempt >= this.maxRetries) {
          const message = error instanceof Error && error.name === "AbortError"
            ? "CoinGecko request timed out."
            : "CoinGecko request failed.";
          throw new ProviderRequestError(message, true);
        }
        await this.sleepImpl(Math.min(250 * (2 ** attempt), MAX_RETRY_DELAY_MS));
      } finally {
        clearTimeout(timer);
      }
    }

    if (!isRecord(body)) throw new ProviderRequestError("CoinGecko returned an invalid payload.", true);
    const now = Date.now();
    const evidence: ProviderEvidence[] = [];
    for (const id of ids) {
      const item = body[id];
      if (!isRecord(item)) continue;
      const price = item.usd;
      const updatedAt = typeof item.last_updated_at === "number"
        ? new Date(item.last_updated_at * 1000).toISOString()
        : undefined;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || !updatedAt) continue;
      const observedMs = Date.parse(updatedAt);
      if (!Number.isFinite(observedMs) || observedMs > now + 60_000 || now - observedMs > MAX_RESPONSE_AGE_MS) continue;
      evidence.push({
        provider: "coingecko",
        metric: "price_usd",
        assetId: id,
        observedAt: updatedAt,
        value: price,
        currency: "USD",
        sourceUrl: "https://www.coingecko.com/en/coins/" + encodeURIComponent(id),
      });
    }
    return evidence;
  }
}
