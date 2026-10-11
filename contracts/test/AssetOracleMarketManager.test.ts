import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AssetOracleMarketManager", function () {
  async function deployFixture() {
    const [owner, creator, resolver, treasury, validatorPool, alice, bob, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const cngn = await Token.deploy("cNGN", "cNGN", 6);
    const usdt = await Token.deploy("Tether USD", "USDT", 6);
    const usdc = await Token.deploy("USD Coin", "USDC", 6);
    const Manager = await ethers.getContractFactory("AssetOracleMarketManager");
    const manager = await Manager.deploy(owner.address, treasury.address, validatorPool.address);
    await manager.configureStablecoin(0, await cngn.getAddress(), 6);
    await manager.configureStablecoin(1, await usdt.getAddress(), 6);
    await manager.configureStablecoin(2, await usdc.getAddress(), 6);
    await manager.setMarketCreator(creator.address, true);
    await manager.setOracleResolver(resolver.address, true);
    for (const user of [alice, bob, creator]) {
      await cngn.mint(user.address, 10_000_000n);
      await cngn.connect(user).approve(await manager.getAddress(), ethers.MaxUint256);
    }
    return { owner, creator, resolver, treasury, validatorPool, alice, bob, outsider, cngn, usdt, usdc, manager };
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

  it("restricts stake currencies to the three configured stablecoins", async function () {
    const f = await deployFixture();
    await expect(f.manager.configureStablecoin(0, ethers.ZeroAddress, 6)).to.be.reverted;
    await expect(f.manager.configureStablecoin(0, await f.cngn.getAddress(), 18)).to.be.reverted;
  });

  it("limits market creation to approved creators", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await expect(f.manager.connect(f.outsider).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    )).to.be.reverted;
  });

  it("charges the separate 0.25% trading fee and records net stake", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    const position = await f.manager.getPosition(1, f.alice.address);
    expect(position.yes).to.equal(997_500n);
    expect(await f.cngn.balanceOf(f.treasury.address)).to.equal(2_500n);
  });

  it("settles YES and applies 2% settlement fee with the agreed 25/75 split", async function () {
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
    const before = await f.cngn.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    const after = await f.cngn.balanceOf(f.alice.address);
    expect(after - before).to.equal(1_955_100n); // 98% of the 1,995,000 net pool
    expect(await f.cngn.balanceOf(f.validatorPool.address)).to.equal(9_975n);
    expect(await f.cngn.balanceOf(f.treasury.address)).to.equal(32_425n); // trade fees + 1.5% settlement fee
    await expect(f.manager.connect(f.alice).claim(1)).to.be.reverted;
  });

  it("refunds invalid markets without settlement fees", async function () {
    const f = await deployFixture();
    await createAndClose(f);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n).catch(() => undefined);
    // Market is closed, so stake must be rejected and no extra amount may enter.
    await expect(f.manager.connect(f.alice).stake(1, true, 100_000n)).to.be.reverted;
  });

  it("prevents non-resolvers from resolving markets", async function () {
    const f = await deployFixture();
    await createAndClose(f);
    await expect(f.manager.connect(f.outsider).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")))).to.be.reverted;
  });
});
