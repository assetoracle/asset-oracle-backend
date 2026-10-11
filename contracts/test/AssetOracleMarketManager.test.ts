import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AssetOracleMarketManager (USDC-only testnet)", function () {
  async function deployFixture() {
    const [owner, creator, resolver, treasury, validatorPool, alice, bob, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const usdc = await Token.deploy("USD Coin Test", "USDC", 6);
    const Manager = await ethers.getContractFactory("AssetOracleMarketManager");
    const manager = await Manager.deploy(owner.address, treasury.address, validatorPool.address);
    await manager.configureStablecoin(0, await usdc.getAddress(), 6);
    await manager.setMarketCreator(creator.address, true);
    await manager.setOracleResolver(resolver.address, true);
    for (const user of [alice, bob, creator]) {
      await usdc.mint(user.address, 10_000_000n);
      await usdc.connect(user).approve(await manager.getAddress(), ethers.MaxUint256);
    }
    return { owner, creator, resolver, treasury, validatorPool, alice, bob, outsider, usdc, manager };
  }

  async function createAndClose(f: Awaited<ReturnType<typeof deployFixture>>) {
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0,
      "Will the test event happen?",
      "YES if the official source confirms the event by the deadline.",
      "https://official.example/result",
      closeTime,
      3600
    );
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
  }

  it("allows only the single USDC enum value and validates its token decimals", async function () {
    const f = await deployFixture();
    await expect(f.manager.configureStablecoin(0, ethers.ZeroAddress, 6)).to.be.reverted;
    await expect(f.manager.configureStablecoin(0, await f.usdc.getAddress(), 18)).to.be.reverted;
    await expect(f.manager.configureStablecoin(1, await f.usdc.getAddress(), 6)).to.be.reverted;
  });

  it("limits market creation to approved creators", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await expect(f.manager.connect(f.outsider).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    )).to.be.reverted;
  });

  it("charges the 0.25% trading fee and records the net USDC stake", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    const position = await f.manager.getPosition(1, f.alice.address);
    expect(position.yes).to.equal(997_500n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(2_500n);
  });

  it("settles YES and splits the 2% settlement fee 25% to validators and 75% to treasury", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.connect(f.bob).stake(1, false, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(1_955_100n);
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(9_975n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(34_925n);
    await expect(f.manager.connect(f.alice).claim(1)).to.be.reverted;
  });

  it("refunds cancelled markets without a settlement fee", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.cancelMarket(1, ethers.keccak256(ethers.toUtf8Bytes("cancelled")));
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).refundCancelled(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(997_500n);
  });

  it("allows full refunds when a closed market times out unresolved", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await time.increase(3600);
    await f.manager.connect(f.outsider).refundTimedOutMarket(1);
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).refundCancelled(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(997_500n);
  });

  it("refunds 75% and retains 25% to Treasury when a resolved outcome has no winning-side stakes", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, false, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(748_125n);
    // Treasury already received the 2,500-unit trading fee, then receives 25% of net stake.
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(251_875n);
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(0n);
  });

  it("prevents non-resolvers from resolving markets", async function () {
    const f = await deployFixture();
    await createAndClose(f);
    await expect(f.manager.connect(f.outsider).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")))).to.be.reverted;
  });

  it("refunds net stake for INVALID outcomes and prevents a second claim", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if the official source confirms the event by the deadline.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.connect(f.bob).stake(1, false, 2_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 3, ethers.keccak256(ethers.toUtf8Bytes("invalid outcome")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);
    const beforeAlice = await f.usdc.balanceOf(f.alice.address);
    const beforeBob = await f.usdc.balanceOf(f.bob.address);
    await f.manager.connect(f.alice).claim(1);
    await f.manager.connect(f.bob).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - beforeAlice).to.equal(997_500n);
    expect((await f.usdc.balanceOf(f.bob.address)) - beforeBob).to.equal(1_995_000n);
    await expect(f.manager.connect(f.alice).claim(1)).to.be.reverted;
    await expect(f.manager.connect(f.bob).claim(1)).to.be.reverted;
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
  });

  it("pays multiple winners proportionally and leaves only documented integer-division dust", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if the official source confirms the event by the deadline.", "official source", closeTime, 3600);
    for (const user of [f.alice, f.bob, f.creator]) await f.manager.connect(user).stake(1, true, 10_001n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);
    const before = await Promise.all([f.alice, f.bob, f.creator].map(user => f.usdc.balanceOf(user.address)));
    for (const user of [f.alice, f.bob, f.creator]) await f.manager.connect(user).claim(1);
    const after = await Promise.all([f.alice, f.bob, f.creator].map(user => f.usdc.balanceOf(user.address)));
    expect(after.reduce((sum, value, i) => sum + value - before[i], 0n)).to.equal(29_328n);
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(149n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(524n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(2n);
    for (const user of [f.alice, f.bob, f.creator]) await expect(f.manager.connect(user).claim(1)).to.be.reverted;
  });

});
