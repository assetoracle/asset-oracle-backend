import test from "node:test";
import assert from "node:assert/strict";
import { resolveEvidenceConsensus } from "./marketEvidenceConsensus.js";

test("evidence remains unreviewed until two validators agree", () => {
  assert.equal(resolveEvidenceConsensus(0, 0), "UNREVIEWED");
  assert.equal(resolveEvidenceConsensus(1, 0), "UNREVIEWED");
  assert.equal(resolveEvidenceConsensus(0, 1), "UNREVIEWED");
  assert.equal(resolveEvidenceConsensus(1, 1), "UNREVIEWED");
});

test("two accepting validators accept the evidence", () => {
  assert.equal(resolveEvidenceConsensus(2, 0), "ACCEPTED");
});

test("two rejecting validators reject the evidence", () => {
  assert.equal(resolveEvidenceConsensus(0, 2), "REJECTED");
});

test("third validator breaks a one-to-one tie", () => {
  assert.equal(resolveEvidenceConsensus(2, 1), "ACCEPTED");
  assert.equal(resolveEvidenceConsensus(1, 2), "REJECTED");
});
