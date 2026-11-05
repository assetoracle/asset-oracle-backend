# Batch 6: Enugu Testnet End-to-End Rehearsal

**Purpose:** Verify the newly deployed Asset Oracle market manager and rehearse one complete YES/NO market lifecycle on Enugu testnet. The new deployment is pending completion of the code review and test gates. This is a testnet-only runbook. The contracts are unaudited; never use real funds.

## Deployment status

No contract address is approved for this release yet. The new contract must be deployed only after the reviewed source, contract tests, backend integration tests, and read-only preflight pass. Record the new deployment address and transaction evidence here after deployment.

## Current gate

- [ ] New 2-of-3 market manager deployed from the reviewed source and address recorded.
- [x] Fixed validator roster documented: primary/Validator 1 `0x3d3724d20d9d5db5a40819869057b37465a0c67d`, Validator 2 `0xb94185491c78e7331c5d53e9b0df74970b3c9b8a`, Validator 3 `0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01`.
- [ ] Attach the new manager's deployment transaction/block evidence and rerun read-only Enugu preflight against that address.
- [ ] Confirm backend and frontend both use the new manager address.
- [ ] Latest contract tests and compile pass on the exact source commit.
- [ ] Ownership-transfer regression test confirms owner, manual creator, automated creator and resolver roles; confirms automation wallet has both publication roles; and confirms temporary deployer roles are revoked.
- [ ] Confirm live backend and frontend both use the same manager address and Enugu RPC.
- [ ] Owner wallet has testnet gas and only test USDC for this rehearsal.
- [ ] No private key is committed, pasted into chat, or placed in frontend environment variables.

**Stop condition:** No manager address is approved yet. Do not run lifecycle transactions until the new contract deployment is completed, deployment evidence is attached, read-only preflight passes, the validator roster and both automation roles are verified, and backend/frontend point to the same new address. Testnet only; unaudited.

## Step 1 — Read-only preflight

From `contracts/` in the backend repository:

```sh
npm install
npm test
npm run compile
npm run preflight:enugu
```

The read-only preflight must check chain ID, approved USDC contract and six decimals, new manager bytecode, owner, Treasury, validator pool, USDC configuration, all three validators, and the dedicated automation wallet's manual and automated publication roles. It sends **no transactions**. A missing new manager address must block activation.

## Step 2 — Wallet and network

- [ ] Connect the test wallet to Asset Chain Enugu (chain ID `42421`).
- [ ] Confirm the connected address is the intended test participant.
- [ ] Confirm the frontend and backend use the same verified manager address and Enugu RPC.
- [ ] Confirm only approved Enugu testnet USDC is shown as stake currency (6 decimals). The new Enugu testnet build currently configures USDC only; do not show cNGN or USDT as usable until separately enabled and verified.

## Step 3 — Create and publish a test market

Use a clearly labelled test question with objective resolution rules, a source of truth, a future close time, and a supported challenge period.

- [ ] Create a proposal using an authorized creator wallet.
- [ ] Publish only after the backend verifies the successful transaction receipt and matching `MarketCreated` event.
- [ ] Check receipt chain ID, transaction target, sender, market ID, question, stablecoin enum (`0` = USDC), close time, and creator.
- [ ] Confirm duplicate publication attempts are rejected.
- [ ] Confirm a non-authorized wallet cannot publish.

Record market ID, transaction hash, block number, creator, question, close time, and evidence links.

## Step 4 — YES/NO staking

- [ ] Fund test participants with test USDC and approve the manager contract.
- [ ] Stake from two distinct test wallets, one on YES and one on NO.
- [ ] Confirm the `Staked` event reports gross amount, 1% trading fee (100 bps), charged separately from the user's stake, and net amount.
- [ ] Confirm the trading fee reaches Treasury and the position/pool totals update.
- [ ] Confirm zero stake, insufficient allowance/balance, wrong token, and stake after close are rejected.
- [ ] Confirm UI and backend values match the on-chain positions and totals.

## Step 5 — Close, resolve, and challenge

- [ ] Verify stakes stop at the configured close time, any wallet can close after the deadline, and early closure fails.
- [ ] Close the market after the deadline; any wallet may call `closeMarket`, while early closure must fail. Record the caller and transaction receipt.
- [ ] Each of the three configured validators may vote once on the initial outcome. Confirm a single vote leaves the market CLOSED, conflicting votes do not resolve it, and matching votes require both the same outcome and identical non-zero evidence hash.
- [ ] Verify two matching votes transition the market to DISPUTED and start the challenge window; verify early finalization is blocked.
- [ ] In a separate test market, submit a valid participant dispute and confirm it enters ARBITRATION rather than enabling immediate refunds.
- [ ] Confirm arbitration also requires two matching votes from distinct configured validators on both outcome and evidence hash; verify the challenge window restarts after consensus.
- [ ] Confirm duplicate votes, unconfigured wallets, and a single validator attempting to resolve are rejected.
- [ ] Exercise the seven-day unresolved-dispute timeout only on a dedicated test market.

## Step 6 — Settlement and refunds

- [ ] Finalize after the challenge window.
- [ ] Claim from a winning participant and verify payout against the contract's formula.
- [ ] Verify the 10% settlement fee is split 15% to Validator Reward Pool and 85% to Treasury.
- [ ] Verify losing participants cannot claim a winning payout and cannot claim twice.
- [ ] Exercise an INVALID outcome on a separate market and verify full net-stake refunds without settlement fee.
- [ ] Exercise cancellation/unresolved timeout on separate markets and verify eligible net-stake refunds.
- [ ] Exercise no-winner outcome on a separate market: each participant receives 75% of their net stake, Treasury retains 25% of total net stake plus rounding dust, and validators receive no no-winner fee.
- [ ] After all claims, verify no unintended token balance remains in the manager contract.
- [ ] On a separate market, leave one participant unclaimed and confirm their payout remains escrowed and dust is not swept early; then claim for that participant and confirm only the true rounding remainder is swept. Never treat unclaimed user principal as dust.

Do not reuse the same market to test mutually exclusive settlement paths.

## Step 7 — Dashboard, referrals, and persistence

- [ ] Confirm the dashboard reads on-chain market count from the configured manager; unavailable metrics remain null rather than fabricated.
- [ ] Confirm market history shows the same market ID, status, outcome, stakes, and settlement state as chain.
- [ ] Confirm referral attribution requires a valid wallet-authenticated flow.
- [ ] Confirm referral qualification occurs only after a verified first stake, not on wallet connect or referral-code visit.
- [ ] Confirm leaderboard/admin review endpoints behave as authorized and do not expose private data.
- [ ] Confirm restart/reload does not duplicate a published market or lose verified publication evidence.

## Evidence record

For each scenario, record **PASS / FAIL / BLOCKED**, network/chain ID, contract address, market ID, transaction hash, expected result, actual result, and explorer link. Never record private keys, seed phrases, or secrets.

## Exit criteria

Batch 6 is complete only when all critical happy-path and negative-path checks pass against the same independently verified deployment, the backend and frontend point to it, and evidence is recorded. Passing local contract unit tests alone does not count as a live end-to-end pass.
