import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { createRateLimiter } from "./rateLimit.js";

function request(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function response() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader(name: string, value: string) { headers.set(name, value); return this; },
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  return { res, headers, get statusCode() { return statusCode; }, get body() { return body; } };
}

test("rate limiter permits requests up to the configured maximum", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  let nextCalls = 0;
  for (let i = 0; i < 2; i += 1) {
    const res = response();
    limiter(request("203.0.113.10"), res.res, () => { nextCalls += 1; });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(nextCalls, 2);
});

test("rate limiter rejects requests above the configured maximum", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  const first = response();
  limiter(request("203.0.113.11"), first.res, () => undefined);

  const second = response();
  let nextCalled = false;
  limiter(request("203.0.113.11"), second.res, () => { nextCalled = true; });

  assert.equal(second.statusCode, 429);
  assert.equal(nextCalled, false);
  assert.equal(second.headers.get("Retry-After") !== undefined, true);
  assert.deepEqual(second.body, {
    error: "Too many requests. Please try again later.",
    code: "RATE_LIMITED",
  });
});

test("rate limits are isolated by client IP", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  const first = response();
  const second = response();
  limiter(request("203.0.113.12"), first.res, () => undefined);
  limiter(request("203.0.113.13"), second.res, () => undefined);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
});
