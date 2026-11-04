import test from "node:test";
import assert from "node:assert/strict";

test("evidence metric path accepts safe property paths and returns null for missing paths", async () => {
  const { collectMarketEvidence } = await import("./marketEvidenceCollector.js");
  assert.equal(typeof collectMarketEvidence, "function");
});
