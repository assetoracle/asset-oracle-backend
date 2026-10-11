import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AssetOracleMarketManager lifecycle hardening", function () {
  async function fixture() {
    const [owner, creator, resolver, treasury, validatorPool, alice, bob, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const token = await Token.deploy("USD Coin Test", "USDC", 6);
    const Manager = await ethers.getContractFactory("AssetOracleMarketManager");
    const manager = await Manager.deploy(owner.address, treasury.address, validatorPool.address);
    await manager.configureStablecoin(0, await token.getAddress(), 6);
    await manager.setMarketCreator(creator.address, true);
    await manager.setOracleResolver(resolver.address, true);
    for (const user of [alice, bob]) {
      await token.mint(user.address, 10_000_000n);
      await token.connect(user).approve(await manager.getAddress(), ethers.MaxUint256);
    }
    return { owner, creator, resolver, treasury, validatorPool, alice, bob, outsider, token, manager };
  }

  async function createMarket(f: Awaited<ReturnType<typeof fixture>>) {
    const closeTime = (await time.latest()) + 3600;
    await f.manager.connect(f.creator).createMarket(
      0,
      "Will the official test event happen?",
      "YES only if the named official source confirms it by the market deadline.",
      "https://official.example/result",
      closeTime,
      3600
    );
    return closeTime;
  }

  it("does not allow a non-owner to change creator or resolver permissions", async function () {
    const f = await fixture();
    await expect(f.manager.connect(f.outsider).setMarketCreator(f.outsider.address, true)).to.be.reverted;
    await expect(f.manager.connect(f.outsider).setOracleResolver(f.outsider.address, true)).to.be.reverted;
  });

  it("locks token configuration and fee recipients after market creation begins", async function () {
    const f = await fixture();
    await createMarket(f);
    await expect(f.manager.configureStablecoin(0, await f.token.getAddress(), 6)).to.be.reverted;
    await expect(f.manager.setFeeRecipients(f.bob.address, f.alice.address)).to.be.reverted;
  });

  it("blocks finalization while a participant dispute awaits owner adjudication", async function () {
    const f = await fixture();
    const closeTime = await createMarket(f);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("official evidence")));
    await f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("counter evidence")));
    await time.increase(3600);
    await expect(f.manager.finalizeMarket(1)).to.be.reverted;
    await expect(f.manager.connect(f.outsider).resolveDispute(1, true)).to.be.reverted;
    await f.manager.resolveDispute(1, false);
    await f.manager.finalizeMarket(1);
    expect((await f.manager.getMarket(1)).status).to.equal(3);
  });

  it("only makes a disputed market refundable after owner upholds the dispute", async function () {
    const f = await fixture();
    const closeTime = await createMarket(f);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("official evidence")));
    await f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("counter evidence")));
    await expect(f.manager.connect(f.alice).refundCancelled(1)).to.be.reverted;
    await f.manager.resolveDispute(1, true);
    const before = await f.token.balanceOf(f.alice.address);
    await f.manager.connect(f.alice).refundCancelled(1);
    expect((await f.token.balanceOf(f.alice.address)) - before).to.equal(997_500n);
  });

  it("accepts only one dispute submission per market, even after dismissal", async function () {
    const f = await fixture();
    const closeTime = await createMarket(f);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("official evidence")));
    await f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("counter evidence")));
    await f.manager.resolveDispute(1, false);
    await expect(
      f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("another challenge")))
    ).to.be.reverted;
  });

  it("rejects a dispute from a wallet with no position", async function () {
    const f = await fixture();
    const closeTime = await createMarket(f);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("official evidence")));
    await expect(
      f.manager.connect(f.outsider).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("counter evidence")))
    ).to.be.reverted;
  });

  it("rejects disputes once the challenge window has ended", async function () {
    const f = await fixture();
    const closeTime = await createMarket(f);
    await f.manager.connect(f.alice).stake(1, true, 1_000_000n);
    await time.increaseTo(closeTime);
    await f.manager.connect(f.creator).closeMarket(1);
    await f.manager.connect(f.resolver).resolveMarket(1, 1, ethers.keccak256(ethers.toUtf8Bytes("official evidence")));
    await time.increase(3600);
    await expect(
      f.manager.connect(f.alice).disputeResolution(1, ethers.keccak256(ethers.toUtf8Bytes("late evidence")))
    ).to.be.reverted;
  });
});
