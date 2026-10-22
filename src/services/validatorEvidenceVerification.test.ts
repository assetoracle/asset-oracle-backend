import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { evidenceHashMatchesSourceUrl } from "./validatorEvidenceVerification.js";

const sourceUrl = "https://official.example/results";
const hash = keccak256(toBytes(sourceUrl));

test("accepts a hash that commits to the exact source URL", () => {
  assert.equal(evidenceHashMatchesSourceUrl(hash, sourceUrl), true);
});

test("normalizes surrounding whitespace consistently", () => {
  assert.equal(evidenceHashMatchesSourceUrl(hash, `  ${sourceUrl}  `), true);
});

test("rejects a hash for a different source URL", () => {
  assert.equal(evidenceHashMatchesSourceUrl(hash, "https://attacker.example/fake"), false);
});

test("rejects malformed hashes", () => {
  assert.equal(evidenceHashMatchesSourceUrl("0x1234", sourceUrl), false);
});
