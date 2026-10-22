import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type PublicClient,
} from "viem";
import { verifyErc20SubmissionPayment } from "./verifyErc20SubmissionPayment.js";
import type { SubmissionQuote } from "./paidSubmissionQuote.js";

const quote: SubmissionQuote = {
  network: "TESTNET",
  token: "USDC",
  tokenAddress: "0x2222222222222222222222222222222222222222",
  tokenDecimals: 6,
  amountAtomic: "10000000",
  usdValue: "10.00",
  issuedAtMs: 1_000_000,
  expiresAtMs: 1_120_000,
  rateSource: "fixed-usdc-testnet-fee",
};

const transferEventAbi = [{
  type: "event",
  name: "Transfer",
  anonymous: false,
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

const baseInput = {
  rpcUrl: "https://rpc.example.invalid",
  expectedChainId: 12345,
  minimumConfirmations: 2,
  transactionHash: `0x${"a".repeat(64)}`,
  authenticatedWallet: "0x1111111111111111111111111111111111111111",
  treasuryAddress: "0x3333333333333333333333333333333333333333",
  quote,
};

function transferLog(to: Address, amount = 10_000_000n) {
  return {
    address: quote.tokenAddress,
    topics: encodeEventTopics({
      abi: transferEventAbi,
      eventName: "Transfer",
      args: { from: baseInput.authenticatedWallet, to },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber: 100n,
    transactionHash: baseInput.transactionHash,
    transactionIndex: 0,
    blockHash: `0x${"b".repeat(64)}`,
    logIndex: 0,
    removed: false,
  };
}

function mockClient(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getChainId: async () => 12345,
    readContract: async () => 6,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, logs: [] }),
    getTransaction: async () => ({
      from: baseInput.authenticatedWallet,
      to: quote.tokenAddress,
    }),
    getBlock: async () => ({ timestamp: 1_050n }),
    getBlockNumber: async () => 101n,
    ...overrides,
  } as unknown as PublicClient;
}

test("rejects malformed transaction hashes before querying the RPC", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(
      { ...baseInput, transactionHash: "not-a-hash" },
      mockClient(),
    ),
    /valid payment transaction hash/,
  );
});

test("rejects an RPC connected to the wrong chain", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getChainId: async () => 1,
    })),
    /wrong chain/,
  );
});

test("rejects when the token's on-chain decimals differ from the stored quote", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      readContract: async () => 18,
    })),
    /decimals do not match/,
  );
});

test("rejects a transaction that failed on-chain", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getTransactionReceipt: async () => ({ status: "reverted", blockNumber: 100n, logs: [] }),
    })),
    /did not succeed/,
  );
});

test("rejects payment from a wallet other than the authenticated wallet", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getTransaction: async () => ({
        from: "0x4444444444444444444444444444444444444444",
        to: quote.tokenAddress,
      }),
    })),
    /sender does not match/,
  );
});

test("rejects payments mined after the quote expiry", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getBlock: async () => ({ timestamp: 1_121n }),
    })),
    /mined after the quote expired/,
  );
});

test("rejects payments without the required confirmation depth", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getBlockNumber: async () => 100n,
    })),
    /required confirmation depth/,
  );
});

test("rejects a transaction that does not call the selected token contract", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getTransaction: async () => ({
        from: baseInput.authenticatedWallet,
        to: "0x5555555555555555555555555555555555555555",
      }),
    })),
    /selected stablecoin contract/,
  );
});

test("accepts payment only when the exact 10 USDC Transfer reaches the configured treasury", async () => {
  const verified = await verifyErc20SubmissionPayment(baseInput, mockClient({
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 100n,
      logs: [transferLog(baseInput.treasuryAddress as Address)],
    }),
  }));

  assert.equal(verified.amountAtomic, "10000000");
  assert.equal(verified.recipient.toLowerCase(), baseInput.treasuryAddress.toLowerCase());
  assert.equal(verified.sender.toLowerCase(), baseInput.authenticatedWallet.toLowerCase());
});

test("rejects a 10 USDC transfer sent to an address other than the configured treasury", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 100n,
        logs: [transferLog("0x4444444444444444444444444444444444444444")],
      }),
    })),
    /exact Transfer event from the payer to the configured treasury/,
  );
});

test("rejects a transfer to the treasury for the wrong amount", async () => {
  await assert.rejects(
    verifyErc20SubmissionPayment(baseInput, mockClient({
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 100n,
        logs: [transferLog(baseInput.treasuryAddress as Address, 9_000_000n)],
      }),
    })),
    /exact Transfer event from the payer to the configured treasury/,
  );
});
