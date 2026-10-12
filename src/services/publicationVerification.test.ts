import test from "node:test";
import assert from "node:assert/strict";
import { verifyPublicationEvidence, type PublicationEvidence } from "./publicationVerification.js";

const wallet = "0x1111111111111111111111111111111111111111";
const manager = "0x2222222222222222222222222222222222222222";

const validEvidence: PublicationEvidence = {
  expectedChainId: 42421,
  actualChainId: 42421,
  receiptStatus: "success",
  transactionTo: manager,
  transactionFrom: wallet,
  managerAddress: manager,
  authenticatedWallet: wallet,
  marketId: "12",
  eventMarketId: "12",
  expectedQuestion: "Will the test pass?",
  eventQuestion: "Will the test pass?",
  eventStablecoin: 0,
  eventCloseTime: 1_800_000_000n,
  expectedCloseTime: 1_800_000_000n,
  eventCreator: wallet,
};

test("accepts matching Enugu publication evidence", () => {
  assert.equal(verifyPublicationEvidence(validEvidence), null);
});

test("rejects wrong chain configuration or RPC chain", () => {
  assert.match(verifyPublicationEvidence({ ...validEvidence, actualChainId: 1 }) ?? "", /chain ID/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, expectedChainId: 1 }) ?? "", /chain ID/i);
});

test("rejects failed transaction receipts", () => {
  assert.match(verifyPublicationEvidence({ ...validEvidence, receiptStatus: "reverted" }) ?? "", /did not succeed/i);
});

test("rejects transaction sent to a different contract", () => {
  assert.match(verifyPublicationEvidence({ ...validEvidence, transactionTo: wallet }) ?? "", /target/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, transactionTo: null }) ?? "", /target/i);
});

test("rejects transaction sender that differs from authenticated wallet", () => {
  assert.match(verifyPublicationEvidence({ ...validEvidence, transactionFrom: manager }) ?? "", /sender/i);
});

test("rejects mismatched MarketCreated event fields", () => {
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventMarketId: "13" }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventQuestion: "Different question" }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventStablecoin: 1 }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventCloseTime: 1n }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventCreator: manager }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventCreator: null }) ?? "", /MarketCreated/i);
});

test("rejects missing market ID, question, stablecoin, close time, or creator evidence", () => {
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventMarketId: null }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventQuestion: null }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventStablecoin: null }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventCloseTime: null }) ?? "", /MarketCreated/i);
  assert.match(verifyPublicationEvidence({ ...validEvidence, eventCreator: null }) ?? "", /MarketCreated/i);
});

test("rejects a creator address that differs only by identity", () => {
  assert.match(
    verifyPublicationEvidence({ ...validEvidence, eventCreator: "0x3333333333333333333333333333333333333333" }) ?? "",
    /MarketCreated/i,
  );
});
