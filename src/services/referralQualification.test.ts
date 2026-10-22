import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isStakeAfterReferralAttribution } from "./referralQualification.js";

test("accepts a confirmed stake whose block timestamp is strictly after attribution", () => {
  const attributedAt = new Date("2026-10-22T12:00:00.500Z");
  const nextSecond = BigInt(Math.floor(attributedAt.getTime() / 1000) + 1);
  assert.equal(isStakeAfterReferralAttribution(nextSecond, attributedAt), true);
});

test("rejects a stake from before referral attribution", () => {
  const attributedAt = new Date("2026-10-22T12:00:00.500Z");
  const priorSecond = BigInt(Math.floor(attributedAt.getTime() / 1000));
  assert.equal(isStakeAfterReferralAttribution(priorSecond, attributedAt), false);
});

test("rejects same-second timestamps because block time cannot prove ordering", () => {
  const attributedAt = new Date("2026-10-22T12:00:00.000Z");
  const sameSecond = BigInt(Math.floor(attributedAt.getTime() / 1000));
  assert.equal(isStakeAfterReferralAttribution(sameSecond, attributedAt), false);
});

test("rejects invalid attribution timestamps", () => {
  assert.equal(isStakeAfterReferralAttribution(1_800_000_000n, "not-a-date"), false);
});
