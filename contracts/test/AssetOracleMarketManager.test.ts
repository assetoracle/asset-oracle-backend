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
    await manager.configureValidators([owner.address, resolver.address, bob.address]);
    await manager.setMarketCreator(creator.address, true);
    await manager.setOracleResolver(resolver.address, true);
    for (const user of [alice, bob, creator]) {
      await usdc.mint(user.address, 10_000_000n);
      await usdc.connect(user).approve(await manager.getAddress(), ethers.MaxUint256);
    }
    return { owner, creator, resolver, treasury, validatorPool, alice, bob, outsider, usdc, manager };
  }


  async function resolveByConsensus(
    f: Awaited<ReturnType<typeof deployFixture>>,
    marketId: number,
    outcome: number,
    evidenceHash: string
  ) {
    await f.manager.connect(f.owner).resolveMarket(marketId, outcome, evidenceHash);
    await f.manager.connect(f.resolver).resolveMarket(marketId, outcome, evidenceHash);
    const market = await f.manager.getMarket(marketId);
    await time.increaseTo(Number(market.resolvedAt + market.challengePeriod));
    await f.manager.finalizeMarket(marketId);
  }

  async function resolveDisputeByConsensus(
    f: Awaited<ReturnType<typeof deployFixture>>,
    marketId: number,
    outcome: number,
    evidenceHash: string
  ) {
    await f.manager.connect(f.owner).resolveDispute(marketId, outcome, evidenceHash);
    await f.manager.connect(f.resolver).resolveDispute(marketId, outcome, evidenceHash);
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


  it("allows owner to adjust fees within bounds and rejects excessive fees", async function () {
    const f = await deployFixture();
    expect(await f.manager.tradingFeeBps()).to.equal(100n);
    expect(await f.manager.settlementFeeBps()).to.equal(500n);
    await f.manager.setTradingFeeBps(200);
    await f.manager.setSettlementFeeBps(400);
    expect(await f.manager.tradingFeeBps()).to.equal(200n);
    expect(await f.manager.settlementFeeBps()).to.equal(400n);
    await expect(f.manager.connect(f.alice).setTradingFeeBps(100)).to.be.reverted;
    await expect(f.manager.setTradingFeeBps(1_001)).to.be.revertedWithCustomError(f.manager, "FeeOutOfRange");
    await expect(f.manager.setSettlementFeeBps(1_001)).to.be.revertedWithCustomError(f.manager, "FeeOutOfRange");
  });

  it("requires one validator for automated markets but two for manual markets", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createAutomatedMarket(
      0, "Will the automated test event happen?", "YES if official source confirms it.",
      "https://official.example/result", closeTime, 3600
    );
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("automated evidence"));
    await f.manager.connect(f.owner).resolveMarket(1, 1, evidence);
    expect((await f.manager.getMarket(1)).status).to.equal(2);
    expect((await f.manager.getMarket(1)).outcome).to.equal(1);
  });

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
    // Validator authority is independent of owner-operated roles; the former owner remains on the fixed validator roster.

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

  it("prevents owner cancellation after close and preserves timeout refunds", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);

    await expect(
      f.manager.cancelMarket(1, ethers.keccak256(ethers.toUtf8Bytes("cancel after close")))
    ).to.be.revertedWithCustomError(f.manager, "InvalidStatus");

    await time.increaseTo(closeTime + 3600);
    await f.manager.refundTimedOutMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(4); // REFUNDABLE.
  });

  it("charges the 1% trading fee separately and records the full USDC stake", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    const position = await f.manager.getPosition(1, f.alice.address);
    expect(position.yes).to.equal(1_000_000n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(10_000n);
  });

  it("settles YES and splits the 5% settlement fee 25% to validators and 75% to treasury", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.connect(f.bob).stake(1, false, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(1_900_000n);
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(25_000n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(95_000n);
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
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(1_000_000n);
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
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(750_000n);
    // Treasury receives the separate trading fee and 25% of net stake under the no-winner policy.
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(260_000n);
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
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));

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
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));

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
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));

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

  it("settles immediately after 2-of-3 consensus and does not reopen the final outcome for challenge", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if official evidence confirms it.", "official source", closeTime, 3600);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("initial evidence")));
    expect((await f.manager.getMarket(1)).status).to.equal(3); // SETTLED immediately after consensus.
    await expect(
      f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("challenge")))
    ).to.be.reverted;
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(950_000n);
  });

  it("distributes payouts in bounded batches and skips participants who already claimed", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(0, "Will the test event happen?", "YES if official evidence confirms it.", "official source", closeTime, 3600);
    for (const user of [f.alice, f.bob, f.creator]) {
      await f.manager.connect(user).stake(1, user.address !== f.bob.address, 1_000_000n);
    }
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    const aliceBefore = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - aliceBefore).to.equal(1_425_000n);
    await f.manager.connect(f.outsider).distributePayouts(1, 0, 50);
    expect(await f.manager.claimCountByMarket(1)).to.equal(3n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
    await expect(f.manager.connect(f.outsider).distributePayouts(1, 3, 50)).to.be.reverted;
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
    await resolveByConsensus(f, 1, 3, ethers.keccak256(ethers.toUtf8Bytes("invalid evidence")));

    const aliceBefore = await f.usdc.balanceOf(f.alice.address);
    const bobBefore = await f.usdc.balanceOf(f.bob.address);
    await f.manager.connect(f.alice).claim(1);
    await f.manager.connect(f.bob).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - aliceBefore).to.equal(1_000_000n);
    expect((await f.usdc.balanceOf(f.bob.address)) - bobBefore).to.equal(2_000_000n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(30_000n);
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


  it("honours creator role revocation while validator authorization remains separate", async function () {
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
    // Validator authorization is controlled by the fixed validator roster, not the legacy resolver role.
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
  });

  it("allows anyone to close after the deadline and rejects staking at or after close", async function () {
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
    await expect(f.manager.connect(f.outsider).closeMarket(1)).to.be.revertedWithCustomError(f.manager, "MarketNotClosable");
    await time.increaseTo(closeTime);
    await f.manager.connect(f.outsider).closeMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(1); // CLOSED
    await expect(f.manager.connect(f.alice).stake(1, true, 1_000_000n)).to.be.reverted;
  });

  it("allows participants to recover an abandoned market after anyone closes it post-deadline", async function () {
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
    await time.increaseTo(closeTime + 3600);
    await f.manager.connect(f.outsider).closeMarket(1);
    await f.manager.connect(f.outsider).refundTimedOutMarket(1);
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).refundCancelled(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(997_500n);
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
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
    await expect(f.manager.connect(f.outsider).resolveMarket(1, 1, evidence)).to.be.reverted;
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await expect(f.manager.connect(f.owner).resolveMarket(1, 0, evidence)).to.be.reverted;
    await resolveByConsensus(f, 1, 1, evidence);
    await expect(
      f.manager.connect(f.owner).resolveMarket(
        1, 2, ethers.keccak256(ethers.toUtf8Bytes("second evidence"))
      )
    ).to.be.reverted;
  });


  it("locks stablecoin and fee-recipient configuration after the first market is created", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if official evidence confirms it.", "https://official.example/result", closeTime, 3600
    );
    await expect(f.manager.configureStablecoin(0, await f.usdc.getAddress(), 6))
      .to.be.revertedWithCustomError(f.manager, "StablecoinConfigurationLocked");
    await expect(f.manager.setFeeRecipients(f.bob.address, f.alice.address))
      .to.be.revertedWithCustomError(f.manager, "StablecoinConfigurationLocked");
  });

  it("pays multiple winning participants proportionally and accounts for rounding dust", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if official evidence confirms it.", "https://official.example/result", closeTime, 3600
    );
    for (const user of [f.alice, f.bob, f.creator]) {
      await f.manager.connect(user).stake(1, true, 10_001n);
    }
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await resolveByConsensus(f, 1, 1, ethers.keccak256(ethers.toUtf8Bytes("evidence")));
    const before = await Promise.all([f.alice, f.bob, f.creator].map(user => f.usdc.balanceOf(user.address)));
    for (const user of [f.alice, f.bob, f.creator]) await f.manager.connect(user).claim(1);
    const after = await Promise.all([f.alice, f.bob, f.creator].map(user => f.usdc.balanceOf(user.address)));
    expect(after.reduce((sum, value, i) => sum + value - before[i], 0n)).to.equal(28_503n);
    expect(await f.usdc.balanceOf(f.validatorPool.address)).to.equal(375n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(1_425n); // Trading fees plus settlement share and rounding dust.
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
    for (const user of [f.alice, f.bob, f.creator]) {
      await expect(f.manager.connect(user).claim(1)).to.be.revertedWithCustomError(f.manager, "AlreadyClaimed");
    }
  });

  it("rejects a second claim after an INVALID outcome has refunded a participant", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "INVALID if official evidence is unavailable.", "https://official.example/result", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await resolveByConsensus(f, 1, 3, ethers.keccak256(ethers.toUtf8Bytes("invalid evidence")));
    const before = await f.usdc.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).claim(1);
    expect((await f.usdc.balanceOf(f.alice.address)) - before).to.equal(997_500n);
    await expect(f.manager.connect(f.alice).claim(1)).to.be.revertedWithCustomError(f.manager, "AlreadyClaimed");
    expect(await f.usdc.balanceOf(await f.manager.getAddress())).to.equal(0n);
  });


  it("requires exactly three distinct validators before markets can be created", async function () {
    const [owner, creator, resolver, treasury, validatorPool, , bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const usdc = await Token.deploy("USD Coin Test", "USDC", 6);
    const Manager = await ethers.getContractFactory("AssetOracleMarketManager");
    const manager = await Manager.deploy(owner.address, treasury.address, validatorPool.address);
    await manager.configureStablecoin(0, await usdc.getAddress(), 6);
    await manager.setMarketCreator(creator.address, true);
    const closeTime = (await time.latest()) + 3600;
    await expect(manager.connect(creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    )).to.be.reverted;
    await expect(manager.configureValidators([owner.address, owner.address, resolver.address])).to.be.reverted;
    await manager.configureValidators([owner.address, resolver.address, bob.address]);
    await expect(manager.configureValidators([owner.address, resolver.address, bob.address])).to.be.reverted;
    await manager.connect(creator).createMarket(
      0, "Will the test event happen?", "YES if confirmed by official source.", "official source", closeTime, 3600
    );
    await expect(manager.configureValidators([owner.address, resolver.address, bob.address])).to.be.reverted;
  });

  it("requires two matching validator votes and prevents duplicate and unauthorized votes", async function () {
    const f = await deployFixture();
    await createAndClose(f);
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("confirmed evidence"));
    await expect(f.manager.connect(f.outsider).resolveMarket(1, 1, evidence)).to.be.reverted;
    await f.manager.connect(f.owner).resolveMarket(1, 1, evidence);
    expect((await f.manager.getMarket(1)).status).to.equal(1); // Still CLOSED after one vote.
    await expect(f.manager.connect(f.owner).resolveMarket(1, 1, evidence)).to.be.reverted;
    await f.manager.connect(f.resolver).resolveMarket(1, 2, evidence);
    expect((await f.manager.getMarket(1)).status).to.equal(1); // Conflicting outcome does not reach consensus.
    await f.manager.connect(f.bob).resolveMarket(1, 1, evidence);
    const market = await f.manager.getMarket(1);
    expect(market.status).to.equal(2); // DISPUTED during the initial challenge window.
    expect(market.outcome).to.equal(1); // YES
    expect(market.evidenceHash).to.equal(evidence);
    await expect(f.manager.finalizeMarket(1)).to.be.revertedWithCustomError(f.manager, "ChallengeWindowActive");
    await time.increaseTo(Number(market.resolvedAt + market.challengePeriod));
    await f.manager.finalizeMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(3); // SETTLED after the challenge window.
  });

  it("starts the challenge period when the second matching validator votes", async function () {
    const f = await deployFixture();
    await createAndClose(f);
    const evidence = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    await f.manager.connect(f.owner).resolveMarket(1, 1, evidence);
    expect((await f.manager.getMarket(1)).status).to.equal(1); // CLOSED after the first vote.
    await f.manager.connect(f.resolver).resolveMarket(1, 1, evidence);
    const market = await f.manager.getMarket(1);
    expect(market.status).to.equal(2); // DISPUTED until challenge window expires.
    expect(market.outcome).to.equal(1); // YES
    expect(market.evidenceHash).to.equal(evidence);
    await expect(f.manager.finalizeMarket(1)).to.be.revertedWithCustomError(f.manager, "ChallengeWindowActive");
    await time.increaseTo(Number(market.resolvedAt + market.challengePeriod));
    await f.manager.finalizeMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(3); // SETTLED after challenge period.
  });

  it("allows a participant to dispute initial consensus and restarts the challenge window after arbitration", async function () {
    const f = await deployFixture();
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0, "Will the test event happen?", "YES if the official source confirms the event by the deadline.",
      "https://official.example/result", closeTime, 3600
    );
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await f.manager.connect(f.bob).stake(1, false, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);

    const initialEvidence = ethers.keccak256(ethers.toUtf8Bytes("initial evidence"));
    await f.manager.connect(f.owner).resolveMarket(1, 1, initialEvidence);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, initialEvidence);
    expect((await f.manager.getMarket(1)).status).to.equal(2);

    const disputeEvidence = ethers.keccak256(ethers.toUtf8Bytes("dispute evidence"));
    await expect(f.manager.connect(f.outsider).disputeResolution(1, disputeEvidence)).to.be.reverted;
    await f.manager.connect(f.alice).disputeResolution(1, disputeEvidence);
    expect((await f.manager.getMarket(1)).status).to.equal(6); // ARBITRATION.

    await f.manager.connect(f.owner).resolveDispute(1, 2, disputeEvidence);
    expect((await f.manager.getMarket(1)).status).to.equal(6); // One arbitration vote is insufficient.
    await f.manager.connect(f.resolver).resolveDispute(1, 2, disputeEvidence);
    const disputed = await f.manager.getMarket(1);
    expect(disputed.status).to.equal(2); // Arbitration consensus starts a fresh challenge window.
    expect(disputed.outcome).to.equal(2); // NO
    expect(disputed.evidenceHash).to.equal(disputeEvidence);
    await expect(f.manager.finalizeMarket(1)).to.be.revertedWithCustomError(f.manager, "ChallengeWindowActive");
    await time.increaseTo(Number(disputed.resolvedAt + disputed.challengePeriod));
    await f.manager.finalizeMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(3);
  });
});
