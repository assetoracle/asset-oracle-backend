import test from "node:test";
import assert from "node:assert/strict";
import { startCandidateScheduler } from "./candidateScheduler.js";

const flagNames = [
  "MARKET_AUTOMATION_ENABLED",
  "MARKET_AUTOMATION_SCHEDULE_ENABLED",
  "MARKET_AUTOMATION_COINGECKO_ASSETS",
  "NODE_ENV",
];

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const original = Object.fromEntries(flagNames.map((key) => [key, process.env[key]]));
  try {
    for (const key of flagNames) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    run();
  } finally {
    for (const key of flagNames) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("candidate scheduler stays off unless both explicit flags are enabled", () => {
  withEnv({
    MARKET_AUTOMATION_ENABLED: "true",
    MARKET_AUTOMATION_SCHEDULE_ENABLED: undefined,
    MARKET_AUTOMATION_COINGECKO_ASSETS: "bitcoin",
  }, () => {
    assert.equal(startCandidateScheduler(), null);
  });
});

test("candidate scheduler refuses to start without a production asset allowlist", () => {
  withEnv({
    MARKET_AUTOMATION_ENABLED: "true",
    MARKET_AUTOMATION_SCHEDULE_ENABLED: "true",
    MARKET_AUTOMATION_COINGECKO_ASSETS: undefined,
    NODE_ENV: "production",
  }, () => {
    assert.equal(startCandidateScheduler(), null);
  });
});

test("candidate scheduler refuses malformed allowlist values", () => {
  withEnv({
    MARKET_AUTOMATION_ENABLED: "true",
    MARKET_AUTOMATION_SCHEDULE_ENABLED: "true",
    MARKET_AUTOMATION_COINGECKO_ASSETS: "bitcoin,bitcoin, bad asset",
    NODE_ENV: "production",
  }, () => {
    assert.equal(startCandidateScheduler(), null);
  });
});
