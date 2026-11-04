import { expect } from "chai";
import { ethers } from "hardhat";

describe("ManualProposalFeeEscrow", function () {
  async function deployFixture() {
    const [admin, reviewer, payer, other, treasury, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const usdc = await Token.deploy("USD Coin Test", "USDC", 6);
    const Escrow = await ethers.getContractFactory("ManualProposalFeeEscrow");
    const escrow = await Escrow.deploy(admin.address, await usdc.getAddress(), treasury.address);
    await usdc.mint(payer.address, 50_000_000n);
    await usdc.connect(payer).approve(await escrow.getAddress(), ethers.MaxUint256);
    await escrow.connect(admin).setReviewer(reviewer.address, true);
    return { admin, reviewer, payer, other, treasury, outsider, usdc, escrow };
  }

  const proposalId = (value: string) => ethers.keccak256(ethers.toUtf8Bytes(value));

  it("escrows exactly 10 USDC and does not send it to Treasury before review", async function () {
    const f = await deployFixture();
    const id = proposalId("proposal-1");
    await expect(f.escrow.connect(f.payer).submitProposalFee(id))
      .to.emit(f.escrow, "ProposalFeeEscrowed")
      .withArgs(id, f.payer.address, 10_000_000n);

    expect(await f.usdc.balanceOf(await f.escrow.getAddress())).to.equal(10_000_000n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(0n);
    const payment = await f.escrow.proposalPayments(id);
    expect(payment.payer).to.equal(f.payer.address);
    expect(payment.decision).to.equal(1n); // PENDING
  });

  it("releases the full fee to the existing Treasury only after reviewer approval", async function () {
    const f = await deployFixture();
    const id = proposalId("proposal-approved");
    await f.escrow.connect(f.payer).submitProposalFee(id);

    await expect(f.escrow.connect(f.reviewer).approveAndRelease(id))
      .to.emit(f.escrow, "ProposalFeeReleased")
      .withArgs(id, f.payer.address, f.treasury.address, 10_000_000n, f.reviewer.address);

    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(10_000_000n);
    expect(await f.usdc.balanceOf(await f.escrow.getAddress())).to.equal(0n);
    expect((await f.escrow.proposalPayments(id)).decision).to.equal(2n); // APPROVED
  });

  it("refunds the complete fee to the original payer after rejection", async function () {
    const f = await deployFixture();
    const id = proposalId("proposal-rejected");
    await f.escrow.connect(f.payer).submitProposalFee(id);
    const before = await f.usdc.balanceOf(f.payer.address);

    await expect(f.escrow.connect(f.reviewer).rejectAndRefund(id))
      .to.emit(f.escrow, "ProposalFeeRefunded")
      .withArgs(id, f.payer.address, 10_000_000n, f.reviewer.address);

    expect(await f.usdc.balanceOf(f.payer.address)).to.equal(before + 10_000_000n);
    expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(0n);
    expect((await f.escrow.proposalPayments(id)).decision).to.equal(3n); // REJECTED
  });

  it("rejects unauthorised reviewers and prevents duplicate decisions", async function () {
    const f = await deployFixture();
    const id = proposalId("proposal-once");
    await f.escrow.connect(f.payer).submitProposalFee(id);

    await expect(f.escrow.connect(f.outsider).approveAndRelease(id)).to.be.reverted;
    await f.escrow.connect(f.reviewer).approveAndRelease(id);
    await expect(f.escrow.connect(f.reviewer).approveAndRelease(id))
      .to.be.revertedWithCustomError(f.escrow, "ProposalNotPending");
    await expect(f.escrow.connect(f.reviewer).rejectAndRefund(id))
      .to.be.revertedWithCustomError(f.escrow, "ProposalNotPending");
  });

  it("prevents duplicate proposal IDs and zero proposal IDs", async function () {
    const f = await deployFixture();
    await expect(f.escrow.connect(f.payer).submitProposalFee(ethers.ZeroHash))
      .to.be.revertedWithCustomError(f.escrow, "InvalidProposalId");
    const id = proposalId("proposal-duplicate");
    await f.escrow.connect(f.payer).submitProposalFee(id);
    await expect(f.escrow.connect(f.other).submitProposalFee(id))
      .to.be.revertedWithCustomError(f.escrow, "ProposalAlreadyExists");
  });

  it("does not let an administrator withdraw or redirect pending funds", async function () {
    const f = await deployFixture();
    const id = proposalId("proposal-no-sweep");
    await f.escrow.connect(f.payer).submitProposalFee(id);
    expect(await f.usdc.balanceOf(await f.escrow.getAddress())).to.equal(10_000_000n);
    expect(f.escrow.interface.hasFunction("withdraw")).to.equal(false);
    expect(f.escrow.interface.hasFunction("rescueTokens")).to.equal(false);
  });

  it("rejects tokens that do not use six decimals", async function () {
    const [admin, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const token18 = await Token.deploy("Wrong Decimal", "BAD", 18);
    const Escrow = await ethers.getContractFactory("ManualProposalFeeEscrow");
    await expect(Escrow.deploy(admin.address, await token18.getAddress(), treasury.address))
      .to.be.revertedWithCustomError(Escrow, "InvalidToken");
  });

  it("rejects zero admin and Treasury addresses", async function () {
    const [admin, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockStablecoin");
    const usdc = await Token.deploy("USD Coin Test", "USDC", 6);
    const Escrow = await ethers.getContractFactory("ManualProposalFeeEscrow");
    await expect(Escrow.deploy(ethers.ZeroAddress, await usdc.getAddress(), treasury.address))
      .to.be.revertedWithCustomError(Escrow, "InvalidAddress");
    await expect(Escrow.deploy(admin.address, await usdc.getAddress(), ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Escrow, "InvalidAddress");
  });
});
