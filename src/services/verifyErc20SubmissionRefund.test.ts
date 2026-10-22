import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type PublicClient } from "viem";
import { verifyErc20SubmissionRefund } from "./verifyErc20SubmissionRefund.js";

const token = "0x2222222222222222222222222222222222222222" as Address;
const treasury = "0x3333333333333333333333333333333333333333" as Address;
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const hash = `0x${"a".repeat(64)}` as `0x${string}`;
const abi = [{
  type: "event", name: "Transfer", anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

function transferLog(from: Address, to: Address, amount = 10_000_000n) {
  return {
    address: token,
    topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber: 100n, transactionHash: hash, transactionIndex: 0,
    blockHash: `0x${"b".repeat(64)}`, logIndex: 0, removed: false,
  };
}
function mockClient(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getChainId: async () => 42421,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, logs: [transferLog(treasury, wallet)] }),
    getTransaction: async () => ({ from: treasury, to: token }),
    getBlockNumber: async () => 101n,
    ...overrides,
  } as unknown as PublicClient;
}
const input = {
  rpcUrl: "https://rpc.example.invalid", expectedChainId: 42421,
  minimumConfirmations: 2, transactionHash: hash,
  treasuryAddress: treasury, recipientWallet: wallet,
  tokenAddress: token, amountAtomic: "10000000",
};

test("accepts only an exact confirmed treasury-to-wallet USDC refund", async () => {
  const result = await verifyErc20SubmissionRefund(input, mockClient());
  assert.equal(result.amountAtomic, "10000000");
  assert.equal(result.recipient.toLowerCase(), wallet.toLowerCase());
});

test("rejects a refund with the wrong recipient or amount", async () => {
  await assert.rejects(verifyErc20SubmissionRefund(input, mockClient({
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, logs: [transferLog(treasury, "0x4444444444444444444444444444444444444444" as Address)] }),
  })), /exact USDC Transfer event/);
  await assert.rejects(verifyErc20SubmissionRefund(input, mockClient({
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, logs: [transferLog(treasury, wallet, 9_000_000n)] }),
  })), /exact USDC Transfer event/);
});

test("rejects a refund from a non-treasury sender and shallow confirmation depth", async () => {
  await assert.rejects(verifyErc20SubmissionRefund(input, mockClient({
    getTransaction: async () => ({ from: wallet, to: token }),
  })), /sender does not match/);
  await assert.rejects(verifyErc20SubmissionRefund(input, mockClient({
    getBlockNumber: async () => 100n,
  })), /confirmation depth/);
});
