import type { Request, RequestHandler } from "express";

type WindowEntry = { count: number; resetAt: number };

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}): RequestHandler {
  const entries = new Map<string, WindowEntry>();
  const message = options.message ?? "Too many requests. Please try again later.";

  return (req: Request, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let entry = entries.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      entries.delete(key);
      entries.set(key, entry);
    }

    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - entry.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > options.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      res.status(429).json({ error: message, code: "RATE_LIMITED" });
      return;
    }

    // Bound memory use if a large number of distinct client IPs reach this process.
    if (entries.size > 10_000) {
      for (const [ip, value] of entries) {
        if (value.resetAt <= now || entries.size > 9_000) entries.delete(ip);
        if (entries.size <= 9_000) break;
      }
    }

    next();
  };
}
