import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPublicationEvidence, type PublicationEvidence } from "./publicationVerification.js";

const validEvidence = (): PublicationEvidence => ({
  expectedChainId: 42421,
  actualChainId: 42421,
  receiptStatus: "success",
  transactionTo: "0xf41fc574765175A59a9d064F7f2719EB7380a452",
  transactionFrom: "0x3d3724d20d9d5db5a40819869057b37465a0c67d",
  managerAddress: "0xf41fc574765175A59a9d064F7f2719EB7380a452",
  authenticatedWallet: "0x3d3724d20d9d5db5a40819869057b37465a0c67d",
  marketId: "7",
  eventMarketId: "7",
  expectedQuestion: "Will the test event happen?",
  eventQuestion: "Will the test event happen?",
  eventStablecoin: 0,
  eventCloseTime: 1_800_000_000n,
  expectedCloseTime: 1_800_000_000n,
  eventCreator: "0x3d3724d20d9d5db5a40819869057b37465a0c67d",
});

test("accepts complete matching Enugu publication evidence", () => {
  assert.equal(verifyPublicationEvidence(validEvidence()), null);
});

test("rejects an RPC on the wrong chain", () => {
  const evidence = validEvidence();
  evidence.actualChainId = 1;
  assert.match(verifyPublicationEvidence(evidence) ?? "", /expected Asset Chain Enugu testnet chain ID/);
});

test("rejects a reverted transaction", () => {
  const evidence = validEvidence();
  evidence.receiptStatus = "reverted";
  assert.match(verifyPublicationEvidence(evidence) ?? "", /transaction did not succeed/);
});

test("rejects a transaction sent to a different contract", () => {
  const evidence = validEvidence();
  evidence.transactionTo = "0x0000000000000000000000000000000000000001";
  assert.match(verifyPublicationEvidence(evidence) ?? "", /target does not match/);
});

test("rejects a sender different from the authenticated creator", () => {
  const evidence = validEvidence();
  evidence.transactionFrom = "0x0000000000000000000000000000000000000001";
  assert.match(verifyPublicationEvidence(evidence) ?? "", /sender does not match/);
});

test("rejects an event for a different market ID or question", () => {
  const wrongId = validEvidence();
  wrongId.eventMarketId = "8";
  assert.match(verifyPublicationEvidence(wrongId) ?? "", /matching MarketCreated event/);

  const wrongQuestion = validEvidence();
  wrongQuestion.eventQuestion = "A different question";
  assert.match(verifyPublicationEvidence(wrongQuestion) ?? "", /matching MarketCreated event/);
});

test("rejects an unapproved stablecoin, wrong close time, or wrong creator", () => {
  const wrongStablecoin = validEvidence();
  wrongStablecoin.eventStablecoin = 1;
  assert.match(verifyPublicationEvidence(wrongStablecoin) ?? "", /matching MarketCreated event/);

  const wrongCloseTime = validEvidence();
  wrongCloseTime.eventCloseTime = 1_800_000_001n;
  assert.match(verifyPublicationEvidence(wrongCloseTime) ?? "", /matching MarketCreated event/);

  const wrongCreator = validEvidence();
  wrongCreator.eventCreator = "0x0000000000000000000000000000000000000001";
  assert.match(verifyPublicationEvidence(wrongCreator) ?? "", /matching MarketCreated event/);
});

test("rejects missing MarketCreated evidence", () => {
  const evidence = validEvidence();
  evidence.eventMarketId = null;
  evidence.eventQuestion = null;
  evidence.eventStablecoin = null;
  evidence.eventCloseTime = null;
  evidence.eventCreator = null;
  assert.match(verifyPublicationEvidence(evidence) ?? "", /matching MarketCreated event/);
});
