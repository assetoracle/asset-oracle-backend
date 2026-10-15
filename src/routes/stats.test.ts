import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import statsRouter from "./stats.js";

const app = express();
app.use("/api/stats", statsRouter);
const server = createServer(app);
let baseUrl = "";

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

test("dashboard blocks on-chain reads when configured chain ID is not Enugu testnet", async () => {
  const originalChainId = process.env.ASSET_CHAIN_ID;
  process.env.ASSET_CHAIN_ID = "1";
  try {
    const response = await fetch(`${baseUrl}/api/stats/dashboard`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      totalUsers: number | null;
      tradingVolume24h: number | string | null;
      totalMarkets: number | null;
      totalSettled: number | null;
      totalTradingVolume: number | string | null;
      dataStatus: Record<string, string>;
    };

    assert.equal(body.totalUsers, null);
    assert.equal(body.tradingVolume24h, null);
    assert.equal(body.totalMarkets, null);
    assert.equal(body.totalSettled, null);
    assert.equal(body.totalTradingVolume, null);
    assert.equal(body.dataStatus.totalMarkets, "RPC_CHAIN_ID_CONFIGURATION_MISMATCH");
    assert.equal(body.dataStatus.totalTradingVolume, "AWAITING_VERIFIED_ONCHAIN_INDEX");
  } finally {
    if (originalChainId === undefined) delete process.env.ASSET_CHAIN_ID;
    else process.env.ASSET_CHAIN_ID = originalChainId;
  }
});
