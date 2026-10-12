import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalAdmin = process.env.ADMIN_WALLET_ADDRESS;
const originalCreators = process.env.MARKET_CREATOR_WALLET_ADDRESSES;
const originalDatabaseUrl = process.env.DATABASE_URL;

const owner = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
const creator = "0x96adb1c2ea8a816d68d27363a55e88b4c507691a";
const secondCreator = "0x8b8a6fb521d372c19a5ff913049475f4c8fb9459";
const ordinaryUser = "0x1111111111111111111111111111111111111111";

after(() => {
  if (originalAdmin === undefined) delete process.env.ADMIN_WALLET_ADDRESS;
  else process.env.ADMIN_WALLET_ADDRESS = originalAdmin;

  if (originalCreators === undefined) delete process.env.MARKET_CREATOR_WALLET_ADDRESSES;
  else process.env.MARKET_CREATOR_WALLET_ADDRESSES = originalCreators;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test("proposal creator authorization recognizes only the owner and configured creator wallets", async (t) => {
  // adminAuth imports walletAuth, which initializes a PostgreSQL pool at module
  // load. These tests only exercise authorization helpers, so use a dummy URL
  // and never open a database connection.
  process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/asset_oracle_test";
  process.env.ADMIN_WALLET_ADDRESS = owner;
  process.env.MARKET_CREATOR_WALLET_ADDRESSES = `${creator}, ${secondCreator}`;

  const { getWalletRole, isAdminWallet, isMarketCreatorWallet } = await import("./adminAuth.js");

  await t.test("owner can create proposals and remains OWNER", () => {
    assert.equal(isAdminWallet(owner), true);
    assert.equal(isMarketCreatorWallet(owner), true);
    assert.equal(getWalletRole(owner), "OWNER");
  });

  await t.test("configured creators can create proposals but are not admins", () => {
    assert.equal(isAdminWallet(creator), false);
    assert.equal(isMarketCreatorWallet(creator), true);
    assert.equal(getWalletRole(creator), "MARKET_CREATOR");
    assert.equal(isMarketCreatorWallet(secondCreator), true);
  });

  await t.test("ordinary wallets cannot create proposals", () => {
    assert.equal(isAdminWallet(ordinaryUser), false);
    assert.equal(isMarketCreatorWallet(ordinaryUser), false);
    assert.equal(getWalletRole(ordinaryUser), "USER");
  });

  await t.test("invalid addresses and invalid configured entries are rejected", () => {
    process.env.MARKET_CREATOR_WALLET_ADDRESSES = `${creator},not-a-wallet`;
    assert.equal(isMarketCreatorWallet("not-a-wallet"), false);
    assert.equal(isMarketCreatorWallet(ordinaryUser), false);
    assert.equal(isMarketCreatorWallet(creator), true);
  });
});
