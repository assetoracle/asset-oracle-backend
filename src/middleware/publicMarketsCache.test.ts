import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { createPublicMarketsCache } from "./publicMarketsCache.js";

function request(url: string): Request {
  return { method: "GET", originalUrl: url, url } as unknown as Request;
}

function response() {
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
    get statusCode() { return statusCode; },
  } as unknown as Response;
  return {
    res,
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

test("public markets cache serves a second query-string variant without another database read", () => {
  const cache = createPublicMarketsCache({ ttlMs: 15_000 });
  let databaseCalls = 0;

  const callEndpoint = (url: string) => {
    const res = response();
    let nextCalls = 0;
    cache(request(url), res.res, () => {
      nextCalls += 1;
      databaseCalls += 1;
      res.res.status(200).json({ markets: [{ id: "market-1" }], count: 1 });
    });
    return { ...res, nextCalls };
  };

  const first = callEndpoint("/api/markets/public?page=1");
  const second = callEndpoint("/api/markets/public?page=999");

  assert.equal(first.nextCalls, 1);
  assert.equal(second.nextCalls, 0);
  assert.equal(databaseCalls, 1);
  assert.deepEqual(second.body, { markets: [{ id: "market-1" }], count: 1 });
  assert.equal(second.statusCode, 200);
});

test("public markets cache does not cache non-200 responses", () => {
  const cache = createPublicMarketsCache({ ttlMs: 15_000 });
  let databaseCalls = 0;

  const callEndpoint = () => {
    const res = response();
    cache(request("/api/markets/public"), res.res, () => {
      databaseCalls += 1;
      res.res.status(503).json({ error: "temporarily unavailable" });
    });
  };

  callEndpoint();
  callEndpoint();
  assert.equal(databaseCalls, 2);
});
