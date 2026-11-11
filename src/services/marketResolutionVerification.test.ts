import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateResolutionRule,
  isHistoricalObservationAligned,
} from "./marketResolutionValidation.js";

const observationTime = "2026-11-11T18:00:00.000Z";

test("CoinGecko recommendation requires the exact configured observation time", () => {
  assert.equal(isHistoricalObservationAligned("coingecko", observationTime, {
    requested_observation_time: observationTime,
    historical_observation_time: "2026-11-11T17:59:00.000Z",
  }), true);
  assert.equal(isHistoricalObservationAligned("coingecko", observationTime, {
    requested_observation_time: "2026-11-11T17:00:00.000Z",
    historical_observation_time: "2026-11-11T16:59:00.000Z",
  }), false);
});

test("CoinGecko rejects a price point after or too far before observation time", () => {
  assert.equal(isHistoricalObservationAligned("coingecko", observationTime, {
    requested_observation_time: observationTime,
    historical_observation_time: "2026-11-11T18:01:00.000Z",
  }), false);
  assert.equal(isHistoricalObservationAligned("coingecko", observationTime, {
    requested_observation_time: observationTime,
    historical_observation_time: "2026-11-11T16:00:00.000Z",
  }), false);
});

test("GDELT recommendation requires a bounded window ending at observation time", () => {
  assert.equal(isHistoricalObservationAligned("gdelt", observationTime, {
    requested_observation_time: observationTime,
    observation_window_start: "2026-11-11T17:00:00.000Z",
    observation_window_end: observationTime,
    articles: [],
  }), true);
  assert.equal(isHistoricalObservationAligned("gdelt", observationTime, {
    requested_observation_time: "2026-11-11T17:00:00.000Z",
    observation_window_start: "2026-11-11T16:00:00.000Z",
    observation_window_end: "2026-11-11T17:00:00.000Z",
    articles: [],
  }), false);
});

test("legacy evidence without observation metadata is not trusted", () => {
  assert.equal(isHistoricalObservationAligned("coingecko", observationTime, {
    market_data: { current_price: { usd: 76543.21 } },
  }), false);
  assert.equal(isHistoricalObservationAligned("gdelt", observationTime, {
    articles: [{ title: "Old result" }],
  }), false);
});

test("resolution comparison semantics remain unchanged", () => {
  assert.equal(evaluateResolutionRule(10, "ABOVE", 10), "NO");
  assert.equal(evaluateResolutionRule(10, "AT_LEAST", 10), "YES");
  assert.equal(evaluateResolutionRule(9, "BELOW", 10), "YES");
});
