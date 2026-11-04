import type { RequestHandler } from "express";

type CachedResponse = {
  body: unknown;
  expiresAt: number;
};

/**
 * Short-lived, process-local cache for the public markets GET endpoint.
 * The middleware is mounted only at /api/markets/public, so query strings
 * intentionally do not create separate cache entries.
 */
export function createPublicMarketsCache(options: { ttlMs?: number } = {}): RequestHandler {
  const ttlMs = options.ttlMs ?? 15_000;
  const cache = new Map<string, CachedResponse>();
  const cacheKey = "public-markets";

  return (_req, res, next) => {
    const now = Date.now();
    const cached = cache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      res.status(200).json(cached.body);
      return;
    }

    if (cached) cache.delete(cacheKey);

    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 200) {
        cache.set(cacheKey, { body, expiresAt: Date.now() + ttlMs });
      }
      return sendJson(body);
    }) as typeof res.json;

    next();
  };
}
