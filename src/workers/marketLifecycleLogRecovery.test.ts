import test from "node:test";
import assert from "node:assert/strict";
import { findLogInBlockRanges } from "./marketLifecycleLogRecovery.js";

test("recovers a matching event from a later bounded block range", async () => {
  const requested: Array<[bigint, bigint]> = [];
  const result = await findLogInBlockRanges(
    5n,
    async (fromBlock, toBlock) => {
      requested.push([fromBlock, toBlock]);
      return fromBlock === 4n ? [{ marketId: 17n }] : [];
    },
    (entry) => entry.marketId === 17n,
    2n,
  );

  assert.deepEqual(requested, [[0n, 1n], [2n, 3n], [4n, 5n]]);
  assert.deepEqual(result, { marketId: 17n });
});

test("returns undefined only after every block range has been checked", async () => {
  let calls = 0;
  const result = await findLogInBlockRanges(
    3n,
    async () => { calls += 1; return []; },
    () => true,
    2n,
  );
  assert.equal(result, undefined);
  assert.equal(calls, 2);
});

test("fails closed when an RPC log range cannot be queried", async () => {
  await assert.rejects(
    findLogInBlockRanges(
      2n,
      async () => { throw new Error("range limit exceeded"); },
      () => true,
      2n,
    ),
    /Unable to recover publication logs in block range 0-1: range limit exceeded/,
  );
});

test("rejects a non-positive chunk size", async () => {
  await assert.rejects(
    findLogInBlockRanges(1n, async () => [], () => true, 0n),
    /chunk size must be positive/,
  );
});
