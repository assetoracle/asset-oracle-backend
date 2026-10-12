import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AssetOracleMarketManager (three approved stablecoins; USDC-only testnet config)", function () {
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

  it("transfers role administration with contract ownership", async function () {
    const f = await deployFixture();
    // A no-op ownership transfer must not accidentally revoke the current owner's roles.
    await f.manager.transferOwnership(f.owner.address);
    expect(await f.manager.hasRole(await f.manager.DEFAULT_ADMIN_ROLE(), f.owner.address)).to.equal(true);
    expect(await f.manager.hasRole(await f.manager.MARKET_CREATOR_ROLE(), f.owner.address)).to.equal(true);
    expect(await f.manager.hasRole(await f.manager.ORACLE_RESOLVER_ROLE(), f.owner.address)).to.equal(true);

    await f.manager.transferOwnership(f.creator.address);

    expect(await f.manager.owner()).to.equal(f.creator.address);
    expect(await f.manager.hasRole(await f.manager.DEFAULT_ADMIN_ROLE(), f.creator.address)).to.equal(true);
    expect(await f.manager.hasRole(await f.manager.DEFAULT_ADMIN_ROLE(), f.owner.address)).to.equal(false);
    expect(await f.manager.hasRole(await f.manager.MARKET_CREATOR_ROLE(), f.creator.address)).to.equal(true);
    expect(await f.manager.hasRole(await f.manager.ORACLE_RESOLVER_ROLE(), f.creator.address)).to.equal(true);
    expect(await f.manager.hasRole(await f.manager.MARKET_CREATOR_ROLE(), f.owner.address)).to.equal(false);
    expect(await f.manager.hasRole(await f.manager.ORACLE_RESOLVER_ROLE(), f.owner.address)).to.equal(false);

    // The new owner inherits owner-operated roles and the former owner loses them.
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    // Check the former owner's role while the market is still CLOSED, so status cannot mask authorization.
    await expect(
      f.manager.connect(f.owner).resolveMarket(1, 2, ethers.keccak256(ethers.toUtf8Bytes("former owner")))
    ).to.be.reverted;
    await f.manager.connect(f.creator).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));

    await f.manager.connect(f.creator).setMarketCreator(f.outsider.address, true);
    expect(await f.manager.hasRole(await f.manager.MARKET_CREATOR_ROLE(), f.outsider.address)).to.equal(true);

    await expect(f.manager.setMarketCreator(f.outsider.address, false)).to.be.reverted;
  });

  it("allows only USDC on the testnet contract and validates its token decimals", async function () {
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

  it("applies the confirmed no-winner policy and sweeps residual rounding dust to Treasury after all claims", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, false, 2n);
    await f.manager.connect(f.bob).stake(1, false, 2n);
    await f.manager.connect(f.creator).stake(1, false, 2n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);

    const aliceBefore = await f.usdc.balanceOf(f.alice.address);
    const bobBefore = await f.usdc.balanceOf(f.bob.address);
    const creatorBefore = await f.usdc.balanceOf(f.creator.address);
    await f.manager.connect(f.alice).claim(1);
    await f.manager.connect(f.bob).claim(1);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(1n);
    await f.manager.connect(f.creator).claim(1);

    expect((await f.usdc.balanceOf(f.alice.address)) - aliceBefore).to.equal(1n);
    expect((await f.usdc.balanceOf(f.bob.address)) - bobBefore).to.equal(1n);
    expect((await f.usdc.balanceOf(f.creator.address)) - creatorBefore).to.equal(1n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(3n); // 1 retained + 2 rounding dust
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(0n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
  });

  it("prevents non-resolvers from resolving markets", async function () {
    const f = await deployFixture();
    await createAndClose(f);
    await expect(f.manager.connect(f.outsider).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")))).to.be.reverted;
  });

  it("rejects claims from nonparticipants and sends final settlement rounding dust to Treasury", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1n);
    await f.manager.connect(f.bob).stake(1, true, 1n);
    await f.manager.connect(f.creator).stake(1, false, 1n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);

    await expect(f.manager.connect(f.outsider).claim(1)).to.be.reverted;
    await f.manager.connect(f.alice).claim(1);
    await f.manager.connect(f.bob).claim(1);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(0n);

    await f.manager.connect(f.creator).claim(1);
    expect(await f.manager.claimCountByMarket(1)).to.equal(3n);
    expect(await f.manager.claimedPayoutsByMarket(1)).to.equal(2n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(1n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
  });


  it("does not sweep settlement dust while a participant payout remains unclaimed", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    // Tiny stakes intentionally produce one token unit of rounding dust.
    await f.manager.connect(f.alice).stake(1, true, 1n);
    await f.manager.connect(f.bob).stake(1, true, 1n);
    await f.manager.connect(f.creator).stake(1, false, 1n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);

    await f.manager.connect(f.alice).claim(1);
    await f.manager.connect(f.creator).claim(1); // Losing participant claims zero.
    expect(await f.manager.claimCountByMarket(1)).to.equal(2n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(0n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(2n);

    await f.manager.connect(f.bob).claim(1);
    expect(await f.manager.claimCountByMarket(1)).to.equal(3n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(1n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
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
    await expect(
      f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("second challenge")))
    ).to.be.revertedWithCustomError(f.manager, "AlreadyDisputed");
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
    await time.increase(3500); // File the dispute near the end of the original one-hour challenge window.
    await f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("challenge")));
    await time.increase(7 * 24 * 60 * 60 - 100);
    await expect(f.manager.connect(f.outsider).refundDisputedTimeout(1)).to.be.reverted;
    await time.increase(100);
    await f.manager.connect(f.outsider).refundDisputedTimeout(1);
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).refundCancelled(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(997_500n);
  });

  it("returns the full net stake for an INVALID outcome without settlement fees", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "INVALID if official evidence is unavailable.", "official source", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.connect(f.bob).stake(1, false, 2_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 3, ethers.keccak256(ethers.toUtf8Bytes("invalid evidence")));
    await time.increase(3600);
    await f.manager.finalizeMarket(1);

    const aliceBefore = await f.usdc.balanceOf(f.alice.address);
    const bobBefore = await f.usdc.balanceOf(f.bob.address);
    await f.manager.connect(f.alice).claim(1);
    await f.manager.connect(f.bob).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - aliceBefore).to.equal(997_500n);
    expect((await f.usdc.balanceOf(f.bob.address)) - bobBefore).to.equal(1_995_000n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(7_500n);
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(0n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
  });

  it("prevents participants from claiming a cancelled-market refund twice", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.cancelMarket(1, ethers.keccak256(ethers.toUtf8Bytes("cancelled")));
    await f.manager.connect(f.alice).refundCancelled(1);
    await expect(f.manager.connect(f.alice).refundCancelled(1)).to.be.revertedWithCustomError(f.manager, "AlreadyClaimed");
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
  });


  it("honours creator and resolver role revocation", async function () {
    const f = await deployFixture();
    await f.manager.setMarketCreator(f.creator.address, false);
    const closeTime = (await time.latest()) + 3600;
    await expect(f.manager.connect(f.creator).createMarket(
      0,
      "Will the test event happen?",
      "YES if the official source confirms the event by the deadline.",
      "https://official.example/result",
      closeTime,
      3600
    )).to.be.reverted;

    await f.manager.setMarketCreator(f.creator.address, true);
    await createAndClose(f);
    await f.manager.setOracleResolver(f.resolver.address, false);
    await expect(
      f.manager.connect(f.resolver).resolveMarket(
        1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence"))
      )
    ).to.be.reverted;
  });

  it("allows only the owner or market creator to close and rejects staking at or after close", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0,
      "Will the test event happen?",
      "YES if the official source confirms the event by the deadline.",
      "https://official.example/result",
      closeTime,
      3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await expect(f.manager.connect(f.outsider).closeMarket(1)).to.be.reverted;
    await f.manager.connect(f.creator).closeMarket(1);
    await expect(f.manager.connect(f.alice).stake(1, true, 1_000_000n)).to.be.reverted;
  });

  it("blocks early, invalid, and duplicate market resolution", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0,
      "Will the test event happen?",
      "YES if the official source confirms the event by the deadline.",
      "https://official.example/result",
      closeTime,
      3600
    );
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    await expect(f.manager.connect(f.resolver).resolveMarket(1, 1, evidence)).to.be.reverted;
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await expect(f.manager.connect(f.resolver).resolveMarket(1, 0, evidence)).to.be.reverted;
    await f.manager.connect(f.resolver).resolveMarket(1, 1, evidence);
    await expect(
      f.manager.connect(f.resolver).resolveMarket(
        1, 2, ethers.keccak256(ethers.toUtf8Bytes("second evidence"))
      )
    ).to.be.reverted;
  });

});
