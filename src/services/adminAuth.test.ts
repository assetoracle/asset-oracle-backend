import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import {
  getWalletRoleDetails,
  isAdminWallet,
  isMarketCreatorWallet,
} from "./adminAuth.js";

const originalAdmin = process.env.ADMIN_WALLET_ADDRESS;
const originalCreators = process.env.MARKET_CREATOR_WALLET_ADDRESSES;

const admin = "0x0000000000000000000000000000000000000001";
const creatorOne = "0x0000000000000000000000000000000000000002";
const creatorTwo = "0x0000000000000000000000000000000000000003";
const outsider = "0x0000000000000000000000000000000000000004";

before(() => {
  process.env.ADMIN_WALLET_ADDRESS = admin;
  process.env.MARKET_CREATOR_WALLET_ADDRESSES = `${creatorOne},${creatorTwo}`;
});

after(() => {
  if (originalAdmin === undefined) delete process.env.ADMIN_WALLET_ADDRESS;
  else process.env.ADMIN_WALLET_ADDRESS = originalAdmin;
  if (originalCreators === undefined) delete process.env.MARKET_CREATOR_WALLET_ADDRESSES;
  else process.env.MARKET_CREATOR_WALLET_ADDRESSES = originalCreators;
});

test("the admin can review generated candidates and approve proposals", () => {
  assert.equal(isAdminWallet(admin), true);
  assert.equal(isMarketCreatorWallet(admin), true);
  assert.equal(getWalletRoleDetails(admin).permissions.approveOrRejectProposals, true);
});

test("the first configured market creator can review and approve proposals", () => {
  assert.equal(isAdminWallet(creatorOne), false);
  assert.equal(isMarketCreatorWallet(creatorOne), true);
  assert.equal(getWalletRoleDetails(creatorOne).role, "MARKET_CREATOR");
  assert.equal(getWalletRoleDetails(creatorOne).permissions.reviewAllProposals, true);
  assert.equal(getWalletRoleDetails(creatorOne).permissions.approveOrRejectProposals, true);
});

test("the second configured market creator can review and approve proposals independently", () => {
  assert.equal(isAdminWallet(creatorTwo), false);
  assert.equal(isMarketCreatorWallet(creatorTwo), true);
  assert.equal(getWalletRoleDetails(creatorTwo).role, "MARKET_CREATOR");
  assert.equal(getWalletRoleDetails(creatorTwo).permissions.reviewAllProposals, true);
  assert.equal(getWalletRoleDetails(creatorTwo).permissions.approveOrRejectProposals, true);
});

test("wallets outside the admin and market creator allowlists cannot review or approve", () => {
  assert.equal(isAdminWallet(outsider), false);
  assert.equal(isMarketCreatorWallet(outsider), false);
  assert.equal(getWalletRoleDetails(outsider).permissions.reviewAllProposals, false);
  assert.equal(getWalletRoleDetails(outsider).permissions.approveOrRejectProposals, false);
});
