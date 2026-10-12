import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/asset_oracle_test";
process.env.ADMIN_WALLET_ADDRESS = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
process.env.MARKET_CREATOR_WALLET_ADDRESSES = "0x96adb1c2ea8a816d68d27363a55e88b4c507691a,0x8b8a6fb521d372c19a5ff913049475f4c8fb9459";

const owner = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
const creator = "0x96adb1c2ea8a816d68d27363a55e88b4c507691a";
const user = "0x1111111111111111111111111111111111111111";
const proposalId = "00000000-0000-4000-8000-000000000001";
const pendingProposal = { id: proposalId, status: "PENDING_APPROVAL" };
let created = 0;
let decisionCalls = 0;

const { createMarketsRouter } = await import("./markets.js");

function makeApp() {
  created = 0;
  decisionCalls = 0;
  const router = createMarketsRouter({
    getWalletRole: (address: string) => address.toLowerCase() === owner.toLowerCase() ? "OWNER" : address.toLowerCase() === creator.toLowerCase() ? "MARKET_CREATOR" : "USER",
    isMarketCreatorWallet: (address: string) => [owner, creator].some((x) => x.toLowerCase() === address.toLowerCase()),
    verifyAdminWallet: async (address: string) => address.toLowerCase() === owner.toLowerCase(),
    createMarketProposal: async (input: unknown, address: string) => {
      created++;
      return { ...pendingProposal, input, createdBy: address };
    },
    getMarketProposal: async () => pendingProposal as never,
    listPublishedMarkets: async () => [],
    listMarketProposals: async () => [pendingProposal] as never,
    listMarketProposalsByWallet: async () => [],
    updateMarketProposalStatus: async (_id: string, status: "APPROVED" | "REJECTED") => {
      decisionCalls++;
      return { ...pendingProposal, status } as never;
    },
    createWalletNonce: async () => "nonce",
    verifyWalletSignature: async (address: string, signature: `0x${string}`) => signature !== "0xdead" && [owner, creator, user].some((x) => x.toLowerCase() === address.toLowerCase()),
  });
  const app = express();
  app.use(express.json());
  app.use("/api/markets", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: String(err) });
  });
  return app;
}

async function withServer(run: (base: string) => Promise<void>) {
  const server = makeApp().listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

const walletAuth = (address: string, signature = "0x1234") => ({
  address, message: "test signed message", signature,
});

const proposal = {
  question: "Will Asset Oracle launch before December?",
  description: "This is a valid sample proposal description for route authorization tests.",
  category: "Crypto",
  closesAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  resolvesAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  resolutionRule: {
    sourceId: "coingecko", metric: "price", comparison: "ABOVE", targetValue: 1,
    observationTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    description: "Use the specified public source and compare its observed metric against the target.",
  },
};

test("ordinary wallet gets 403 on proposal submission and nothing is persisted", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/proposals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, walletAuth: walletAuth(user) }),
    });
    assert.equal(response.status, 403);
    assert.equal(created, 0);
  });
});

test("configured creator can submit a valid proposal", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/proposals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, walletAuth: walletAuth(creator) }),
    });
    assert.equal(response.status, 201);
    assert.equal(created, 1);
    assert.equal((await response.json()).proposal.createdBy, creator);
  });
});

test("creator cannot list or decide admin proposals; owner can decide", async () => {
  await withServer(async (base) => {
    const list = await fetch(`${base}/api/markets/admin/proposals/list`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(walletAuth(creator)),
    });
    assert.equal(list.status, 403);

    const decision = await fetch(`${base}/api/markets/admin/proposals/${proposalId}/decision`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "APPROVED", walletAuth: walletAuth(creator) }),
    });
    assert.equal(decision.status, 403);
    assert.equal(decisionCalls, 0);

    const ownerDecision = await fetch(`${base}/api/markets/admin/proposals/${proposalId}/decision`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "APPROVED", walletAuth: walletAuth(owner) }),
    });
    assert.equal(ownerDecision.status, 200);
    assert.equal(decisionCalls, 1);
  });
});

test("invalid signatures are rejected before proposal creation", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/proposals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, walletAuth: walletAuth(creator, "0xdead") }),
    });
    assert.equal(response.status, 401);
    assert.equal(created, 0);
  });
});

// These tests exercise the actual Express routes with isolated dependencies and no database writes.
