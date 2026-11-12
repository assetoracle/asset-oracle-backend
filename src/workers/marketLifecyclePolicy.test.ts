import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canProcessPayoutBatch,
  getPayoutBatchSize,
  isDisputeRefundDue,
  isMarketClosable,
  isMarketFinalizable,
  isUnresolvedRefundDue,
  normalizePayoutStartIndex,
  isProposalExpiredForNewPublication,
} from "./marketLifecyclePolicy.js";

const hour = 3600n;
const sevenDays = 7n * 24n * hour;

describe("market lifecycle eligibility policy", () => {
  it("closes only OPEN markets at or after the close deadline", () => {
    assert.equal(isMarketClosable(0, 100n, 99n), false);
    assert.equal(isMarketClosable(0, 100n, 100n), true);
    assert.equal(isMarketClosable(1, 100n, 200n), false);
  });

  it("allows unresolved refunds only after close time plus challenge period", () => {
    assert.equal(isUnresolvedRefundDue(1, 100n, hour, 3699n), false);
    assert.equal(isUnresolvedRefundDue(1, 100n, hour, 3700n), true);
    assert.equal(isUnresolvedRefundDue(2, 100n, hour, 5000n), false);
  });

  it("finalizes only validator-resolved markets after the full challenge period", () => {
    assert.equal(isMarketFinalizable(2, 100n, hour, 3699n), false);
    assert.equal(isMarketFinalizable(2, 100n, hour, 3700n), true);
    assert.equal(isMarketFinalizable(1, 100n, hour, 5000n), false);
  });

  it("refunds arbitration timeout only after seven days without leaving arbitration", () => {
    assert.equal(isDisputeRefundDue(6, 100n, sevenDays, 100n + sevenDays - 1n), false);
    assert.equal(isDisputeRefundDue(6, 100n, sevenDays, 100n + sevenDays), true);
    assert.equal(isDisputeRefundDue(2, 100n, sevenDays, 100n + sevenDays), false);
  });

  it("enforces settled status and the per-run payout batch cap", () => {
    assert.equal(canProcessPayoutBatch(3, 9, 10), true);
    assert.equal(canProcessPayoutBatch(3, 10, 10), false);
    assert.equal(canProcessPayoutBatch(2, 0, 10), false);
  });

  it("recovers safely from persisted payout cursors that are stale or out of range", () => {
    assert.equal(normalizePayoutStartIndex(120, 50), 50);
    assert.equal(normalizePayoutStartIndex(120, 120), 0);
    assert.equal(normalizePayoutStartIndex(120, -1), 0);
    assert.equal(normalizePayoutStartIndex(0, 0), 0);
  });

  it("bounds payout batches by remaining participants and the configured batch size", () => {
    assert.equal(getPayoutBatchSize(120, 50, 50), 50);
    assert.equal(getPayoutBatchSize(120, 100, 50), 20);
    assert.equal(getPayoutBatchSize(120, 120, 50), 0);
  });
});

test("expired proposals are blocked from new publication after reconciliation", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  assert.equal(isProposalExpiredForNewPublication("2026-11-11T12:00:00.000Z", now), true);
  assert.equal(isProposalExpiredForNewPublication("2026-11-13T12:00:00.000Z", now), false);
  assert.equal(isProposalExpiredForNewPublication("invalid", now), true);
});
