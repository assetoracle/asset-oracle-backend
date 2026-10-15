# Batch 6: Enugu Testnet End-to-End Rehearsal

**Purpose:** Verify the deployed Asset Oracle market manager and rehearse one complete YES/NO market lifecycle on Enugu testnet. This is a testnet-only runbook. The contracts are unaudited; never use real funds.

## Current deployment record

- Network: Asset Chain Enugu testnet, chain ID `42421`
- RPC: `https://enugu-rpc.assetchain.org`
- Explorer: `https://scan-testnet.assetchain.org`
- Market manager: `0xf41fc574765175A59a9d064F7f2719EB7380a452`
- Deployment transaction: `0x01445c8093ae92e108418cec3e411388d8533cf746935aa53a32682a972103e1`
- Deployment block: `4502688`
- Configured USDC: `0xc33741fddEBeA854d265db6F9707900Efb0211a2` (6 decimals)
- Treasury: `0x650fBE31b1710b27Ea9eBe03862BC93145Fb3d77`
- Validator reward pool: `0xb86e97b85e816ed0fe170a2dc3b5558232792553`
- Owner/resolver: `0x3d3724d20d9d5db5a40819869057b37465a0c67d`
- Deployment, USDC configuration, and resolver configuration transactions were reported successful. The read-only preflight passed for chain ID, manager bytecode, owner, Treasury, validator pool, USDC configuration, and creator/resolver roles.
- The preflight reported zero markets at the time it was run. Re-read the live count before any market test.
- Frontend and backend environment variables were reported updated by the operator; confirm live configuration after the backend deployment finishes.

## Current gate

- [x] Current 2-of-3 manager address recorded: `0x5fc327f55cf533ed5d05337f835be37ff1e0db1f`.
- [x] Fixed validator roster documented: primary/Validator 1 `0x3d3724d20d9d5db5a40819869057b37465a0c67d`, Validator 2 `0xb94185491c78e7331c5d53e9b0df74970b3c9b8a`, Validator 3 `0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01`.
- [ ] Attach the current manager's deployment transaction/block evidence and rerun read-only Enugu preflight against that address.
- [ ] Confirm live backend and frontend both use the current 2-of-3 manager.
- [ ] Latest contract tests and compile pass on the exact source commit.
- [ ] Ownership-transfer regression test confirms admin, creator, and resolver roles move to the new owner and are revoked from the former owner.
- [ ] Confirm live backend and frontend both use the same manager address and Enugu RPC.
- [ ] Owner wallet has testnet gas and only test USDC for this rehearsal.
- [ ] No private key is committed, pasted into chat, or placed in frontend environment variables.

**Stop condition:** Do not use the legacy manager for new market creation or validator-consensus settlement. The current 2-of-3 manager is `0x5fc327f55cf533ed5d05337f835be37ff1e0db1f`. Before lifecycle transactions, attach its deployment evidence, rerun read-only preflight, confirm its live validator roster and owner permissions, and verify backend/frontend point to this same address. Testnet only; unaudited.

## Step 1 — Read-only preflight

From `contracts/` in the backend repository:

```sh
npm install
npm test
npm run compile
npm run preflight:enugu
```

The preflight reads the RPC only. It checks chain ID, approved USDC contract and six decimals, manager code, owner, Treasury, validator pool, USDC configuration, and owner creator/resolver roles. It sends **no transactions**. A missing manager address should report BLOCKED and exit with code 2.

## Step 2 — Wallet and network

- [ ] Connect the test wallet to Asset Chain Enugu (chain ID `42421`).
- [ ] Confirm the connected address is the intended test participant.
- [ ] Confirm the frontend and backend use the same verified manager address and Enugu RPC.
- [ ] Confirm only approved Enugu testnet USDC is shown as stake currency (6 decimals). This deployed contract currently configures USDC only; do not show cNGN or USDT as usable on this deployment.

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
- [ ] Confirm the `Staked` event reports gross amount, 0.25% trading fee, and net amount.
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
- [ ] Verify the 2% settlement fee is split 25% to Validator Reward Pool and 75% to Treasury.
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
