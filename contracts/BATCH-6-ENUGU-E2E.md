# Batch 6: Enugu Testnet End-to-End Rehearsal

**Purpose:** Verify the deployed Asset Oracle market manager and rehearse one complete YES/NO market lifecycle on Enugu testnet. This is a testnet-only runbook. The contracts are unaudited; never use real funds.

## Current gate

- [ ] Contract hardening PR reviewed and merged by the repository owner.
- [ ] Contract tests and compile pass on the exact commit selected for deployment.
- [ ] Ownership-transfer regression test confirms admin, creator, and resolver roles move to the new owner and are revoked from the former owner.
- [ ] Deployment transaction hash and manager address are available.
- [ ] Manager address is independently verified on the Enugu explorer and contract code exists at that address.
- [ ] Backend `ASSET_ORACLE_MARKET_MANAGER_ADDRESS` and frontend `VITE_ASSET_ORACLE_MARKET_MANAGER` are set to that same verified address.
- [ ] Backend RPC reports chain ID `42421`.
- [ ] Owner wallet has testnet gas and only test USDC for this rehearsal.
- [ ] No private key is committed, pasted into chat, or placed in frontend environment variables.

**Stop condition:** The manager address is currently unverified/unconfigured. Do not publish a market or submit any lifecycle transaction until the gate above is satisfied.

## Step 1 — Read-only preflight

From `contracts/` on branch `test/batch-6-enugu-e2e-rehearsal`:

```sh
npm install
npm test
npm run compile
npm run preflight:enugu
```

The preflight reads the RPC only. It checks chain ID, the approved USDC contract and 6 decimals, manager code, owner, Treasury, validator pool, USDC configuration, and owner creator/resolver roles. It sends **no transactions**. A missing manager address should report BLOCKED and exit with code 2; that is expected until a deployment is independently verified.

## Step 2 — Wallet and network

- [ ] Connect the test wallet to Asset Chain Enugu (chain ID `42421`).
- [ ] Confirm the connected address is the intended test participant.
- [ ] Confirm the frontend and backend use the same verified manager address and Enugu RPC.
- [ ] Confirm only approved Enugu testnet USDC is shown as stake currency (6 decimals). No cNGN or USDT on this testnet contract.

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
- [ ] Resolve only from the configured resolver role, with YES or NO and a non-zero evidence hash.
- [ ] Verify the challenge window blocks early finalization.
- [ ] In a separate test market, submit a valid participant dispute and confirm it enters arbitration rather than enabling immediate refunds.
- [ ] Confirm only the owner can adjudicate; verify replacement evidence restarts the challenge window.
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

- [ ] Confirm the dashboard reads only verified market/transaction sources; unavailable stats remain null rather than fabricated zeroes.
- [ ] Confirm market history shows the same market ID, status, outcome, stakes, and settlement state as chain.
- [ ] Confirm referral attribution requires a valid wallet-authenticated flow.
- [ ] Confirm referral qualification occurs only after a verified first stake, not on wallet connect or referral-code visit.
- [ ] Confirm leaderboard/admin review endpoints behave as authorized and do not expose private data.
- [ ] Confirm restart/reload does not duplicate a published market or lose verified publication evidence.

## Evidence record

For each scenario, record **PASS / FAIL / BLOCKED**, network/chain ID, contract address, market ID, transaction hash, expected result, actual result, and explorer link. Never record private keys, seed phrases, or secrets.

## Exit criteria

Batch 6 is complete only when all critical happy-path and negative-path checks pass against the same independently verified deployment, the backend and frontend point to it, and evidence is recorded. Passing local contract unit tests alone does not count as a live end-to-end pass.
