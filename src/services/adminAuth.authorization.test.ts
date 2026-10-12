import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getWalletRole, isMarketCreatorWallet } from "./adminAuth.js";

const owner = "0x3d3724d20d9d5db5a40819869057b37465a0c67d";
const creator = "0x96adb1c2ea8a816d68d27363a55e88b4c507691a";
const secondCreator = "0x8b8a6fb521d372c19a5ff913049475f4c8fb9459";
const ordinaryUser = "0x1111111111111111111111111111111111111111";

const previousAdmin = process.env.ADMIN_WALLET_ADDRESS;
const previousCreators = process.env.MARKET_CREATOR_WALLET_ADDRESSES;
process.env.ADMIN_WALLET_ADDRESS = owner;
process.env.MARKET_CREATOR_WALLET_ADDRESSES = `${creator},${secondCreator}`;

after(() => {
  if (previousAdmin === undefined) delete process.env.ADMIN_WALLET_ADDRESS;
  else process.env.ADMIN_WALLET_ADDRESS = previousAdmin;
  if (previousCreators === undefined) delete process.env.MARKET_CREATOR_WALLET_ADDRESSES;
  else process.env.MARKET_CREATOR_WALLET_ADDRESSES = previousCreators;
});

test("owner is authorized as a creator but retains the OWNER role", () => {
  assert.equal(isMarketCreatorWallet(owner), true);
  assert.equal(getWalletRole(owner), "OWNER");
});

test("configured creator wallets are authorized", () => {
  assert.equal(isMarketCreatorWallet(creator), true);
  assert.equal(isMarketCreatorWallet(secondCreator), true);
  assert.equal(getWalletRole(creator), "MARKET_CREATOR");
});

test("ordinary wallets and invalid addresses are not creators", () => {
  assert.equal(isMarketCreatorWallet(ordinaryUser), false);
  assert.equal(getWalletRole(ordinaryUser), "USER");
  assert.equal(isMarketCreatorWallet("not-an-address"), false);
});
