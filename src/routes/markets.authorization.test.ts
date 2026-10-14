import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createMarketsRouter } from "./markets.js";

const owner = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
const creator = "0x96adb1c2ea8a816d68d27363a55e88b4c507691a";
const user = "0x1111111111111111111111111111111111111111";
const proposalId = "00000000-0000-4000-8000-000000000001";
let persisted = 0;
let decisions = 0;
let publications = 0;

const proposal = {
  question: "Will Asset Oracle launch before December?",
  description: "A sufficiently detailed sample proposal for authorization route tests.",
  category: "Crypto",
  closesAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  resolvesAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  resolutionRule: {
    sourceId: "coingecko", metric: "price", comparison: "ABOVE", targetValue: 1,
    observationTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    description: "Use the specified public source and compare its observed metric against the target.",
  },
};

const walletAuth = (address: string, signature = "0x1234") => ({
  address, message: "test signed message", signature,
});

function makeApp() {
  persisted = 0;
  decisions = 0;
  publications = 0;
  const router = createMarketsRouter({
    getWalletRole: ((address: string) =>
      address.toLowerCase() === owner.toLowerCase() ? "OWNER" :
      address.toLowerCase() === creator.toLowerCase() ? "MARKET_CREATOR" : "USER") as never,
    isMarketCreatorWallet: ((address: string) =>
      [owner, creator].some((x) => x.toLowerCase() === address.toLowerCase())) as never,
    verifyAdminWallet: (async (address: string) => address.toLowerCase() === owner.toLowerCase()) as never,
    verifyWalletSignature: (async (_address: string, signature: string) => signature !== "0xdead") as never,
    createMarketProposal: (async (input: typeof proposal, address: string) => {
      persisted++;
      return { ...input, id: proposalId, status: "PENDING_APPROVAL", walletAddress: address } as never;
    }) as never,
    getMarketProposal: (async () => ({ ...proposal, id: proposalId, status: "PENDING_APPROVAL" })) as never,
    listMarketProposals: (async () => []) as never,
    listMarketProposalsByWallet: (async () => []) as never,
    listPublishedMarkets: (async () => []) as never,
    updateMarketProposalStatus: (async (_id: string, status: "APPROVED" | "REJECTED") => {
      decisions++;
      return { ...proposal, id: proposalId, status };
    }) as never,
    recordOnchainPublication: (async () => {
      publications++;
      return { ...proposal, id: proposalId, status: "APPROVED" } as never;
    }) as never,
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

test("ordinary authenticated wallet receives 403 and proposal is not persisted", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/proposals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, walletAuth: walletAuth(user) }),
    });
    assert.equal(response.status, 403);
    assert.equal(persisted, 0);
  });
});

test("configured creator can submit a valid proposal", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/proposals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, walletAuth: walletAuth(creator) }),
    });
    assert.equal(response.status, 201);
    assert.equal(persisted, 1);
    assert.equal((await response.json()).proposal.walletAddress, creator);
  });
});

test("invalid wallet signature receives 401 and proposal is not persisted", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/proposals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal, walletAuth: walletAuth(creator, "0xdead") }),
    });
    assert.equal(response.status, 401);
    assert.equal(persisted, 0);
  });
});

test("role endpoint reports permissions for owner, creator, and ordinary user", async () => {
  await withServer(async (base) => {
    for (const [address, expectedRole, canCreate, canReview] of [
      [owner, "OWNER", true, true],
      [creator, "MARKET_CREATOR", true, false],
      [user, "USER", false, false],
    ] as const) {
      const response = await fetch(`${base}/api/markets/auth/role`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(walletAuth(address)),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.role, expectedRole);
      assert.equal(body.permissions.createMarketProposal, canCreate);
      assert.equal(body.permissions.reviewAllProposals, canReview);
      assert.equal(body.permissions.approveOrRejectProposals, canReview);
    }
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
    assert.equal(decisions, 0);

    const ownerDecision = await fetch(`${base}/api/markets/admin/proposals/${proposalId}/decision`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "APPROVED", walletAuth: walletAuth(owner) }),
    });
    assert.equal(ownerDecision.status, 200);
    assert.equal(decisions, 1);
  });
});


test("ordinary wallet cannot publish an approved proposal or record publication", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/markets/admin/proposals/${proposalId}/publish`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        txHash: `0x${"1".repeat(64)}`,
        marketId: "1",
        walletAuth: walletAuth(user),
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(publications, 0);
  });
});
