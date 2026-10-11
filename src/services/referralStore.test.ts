import test from "node:test";
import assert from "node:assert/strict";
import { createReferralCodeValue, fingerprintIp } from "./referralUtils.js";

test("referral codes are uppercase hex and 16 characters", () => {
  const code = createReferralCodeValue();
  assert.match(code, /^[0-9A-F]{16}$/);
});

test("IP fingerprint is disabled when no secret is configured", () => {
  const previous = process.env.IP_FINGERPRINT_SECRET;
  delete process.env.IP_FINGERPRINT_SECRET;
  try {
    assert.equal(fingerprintIp("203.0.113.10"), null);
    assert.equal(fingerprintIp(undefined), null);
  } finally {
    if (previous === undefined) delete process.env.IP_FINGERPRINT_SECRET;
    else process.env.IP_FINGERPRINT_SECRET = previous;
  }
});

test("IP fingerprint is deterministic, opaque, and secret-dependent", () => {
  const previous = process.env.IP_FINGERPRINT_SECRET;
  try {
    process.env.IP_FINGERPRINT_SECRET = "test-secret-one";
    const first = fingerprintIp("203.0.113.10");
    assert.ok(first);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(fingerprintIp("203.0.113.10"), first);
    assert.notEqual(first, "203.0.113.10");
    process.env.IP_FINGERPRINT_SECRET = "test-secret-two";
    assert.notEqual(fingerprintIp("203.0.113.10"), first);
  } finally {
    if (previous === undefined) delete process.env.IP_FINGERPRINT_SECRET;
    else process.env.IP_FINGERPRINT_SECRET = previous;
  }
});
