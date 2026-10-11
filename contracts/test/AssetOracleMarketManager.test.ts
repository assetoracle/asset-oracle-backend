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

  it("routes disputes to owner adjudication instead of immediately enabling refunds", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("initial evidence")));
    await expect(f.manager.connect(f.outsider).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("challenge")))).to.be.reverted;
    await f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("challenge")));
    expect((await f.manager.getMarket(1)).status).to.equal(6); // ARBITRATION
    await expect(f.manager.connect(f.outsider).resolveDispute(1, 2, ethers.keccak256(ethers.toUtf8Bytes("decision")))).to.be.reverted;
    await f.manager.resolveDispute(1, 2, ethers.keccak256(ethers.toUtf8Bytes("decision")));
    expect((await f.manager.getMarket(1)).status).to.equal(2); // DISPUTED; challenge window restarts
    await time.increase(3600);
    await f.manager.finalizeMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(3); // SETTLED
  });

  it("allows refunds after seven days if a dispute is not adjudicated", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("initial evidence")));
    await f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("challenge")));
    await time.increase(7 * 24 * 60 * 60);
    await f.manager.connect(f.outsider).refundDisputedTimeout(1);
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).refundCancelled(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(997_500n);
  });
});
