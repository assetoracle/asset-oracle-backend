import test from "node:test";
import assert from "node:assert/strict";
import { formatIndexedAmount, getWalletIndexerStatus, normalizeManagerAddresses } from "./walletHistory.js";
const current = "0x1111111111111111111111111111111111111111";
const legacy = "0x2222222222222222222222222222222222222222";
const now = Date.now();
test("includes current and legacy managers once and rejects malformed addresses", () => assert.deepEqual(normalizeManagerAddresses(current, [legacy, current.toUpperCase(), "bad"]), [current, legacy]));
test("formats six-decimal token amounts", () => assert.equal(formatIndexedAmount("1234567", 6), "1.234567"));
test("formats eighteen-decimal token amounts", () => assert.equal(formatIndexedAmount("1234567890000000000", 18), "1.23456789"));
test("does not guess decimals when token metadata is unavailable", () => assert.equal(formatIndexedAmount("1234567", null), null));
test("supports zero-decimal tokens and null amounts", () => { assert.equal(formatIndexedAmount("123", 0), "123"); assert.equal(formatIndexedAmount(null, 6), null); });
test("reports a missing legacy cursor as not initialized", () => assert.equal(getWalletIndexerStatus([current, legacy], [{ manager_address: current, last_scanned_block: "100", updated_at: new Date(now) }], 100n, now), "INDEXER_NOT_INITIALIZED"));
test("reports behind and stale cursors as catching up", () => {
 assert.equal(getWalletIndexerStatus([current], [{ manager_address: current, last_scanned_block: "90", updated_at: new Date(now) }], 100n, now), "INDEXER_CATCHING_UP");
 assert.equal(getWalletIndexerStatus([current], [{ manager_address: current, last_scanned_block: "100", updated_at: new Date(now - 121_000) }], 100n, now), "INDEXER_CATCHING_UP");
});
test("reports all configured managers verified only when their cursors are current", () => assert.equal(getWalletIndexerStatus([current, legacy], [
 { manager_address: current, last_scanned_block: "100", updated_at: new Date(now) },
 { manager_address: legacy, last_scanned_block: "98", updated_at: new Date(now) },
], 100n, now), "VERIFIED_ONCHAIN_EVENT_INDEX"));
