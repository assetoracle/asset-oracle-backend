# Asset Oracle Contracts

This workspace is isolated under `contracts/` so the existing frontend and API package manifests remain unchanged.

## Current scope

- Solidity 0.8.28, OpenZeppelin access control, SafeERC20 and reentrancy protection.
- **Testnet scope:** the contract and Enugu deployment are USDC-only for this phase, at `0xc33741fddEBeA854d265db6F9707900Efb0211a2`. The deployment script rejects other token addresses and configures only USDC. cNGN and USDT support will be implemented and verified in the separate mainnet phase; do not use mainnet tokens or addresses on testnet.
- Separate market-creator role and a fixed roster of three outcome validators. The roster must be configured before the first market and contains three distinct wallets. Two validators must independently submit the same outcome and evidence hash for resolution; one vote is insufficient. Dispute adjudication uses the same 2-of-3 rule. The legacy oracle-resolver role remains for compatibility but does not authorize outcome resolution.
- Binary YES/NO stakes held in contract escrow.
- All trading-fee revenue (0.25%) goes to Treasury, including any allocation previously described as market incentives. Successful-settlement fees are 2%, split 25% to the validator reward pool and 75% to Treasury.
- Invalid/cancelled markets have a 0% settlement fee and allow users to recover their net stake. Anyone can close a market once its staking deadline has passed, preventing abandoned open markets from trapping participant funds; before the deadline, closure is rejected.
- **Confirmed no-winner policy:** refund 75% of each participant's net stake and retain 25% of the market's total net stake for Treasury. The Validator Reward Pool receives nothing from a no-winner market. After every participant claims, any leftover token-unit rounding remainder is also sent to Treasury.
- Resolution evidence hash and a challenge window are recorded before finalization.
- A valid participant dispute enters arbitration and does not immediately unlock refunds. Two of the three configured validators must agree on the replacement outcome and evidence hash, which restarts the challenge window. If arbitration is not completed within seven days, anyone can unlock participant refunds.
- Successful settlements count unique participants and their claims. Once every participant claims, any rounding remainder after user payouts and the 2% settlement fee is sent to Treasury and emitted as `SettlementDustSwept`. Non-participants cannot call `claim` to affect this accounting. There is deliberately no expiry that forfeits an unclaimed participant payout: if any participant does not claim, their owed payout remains in escrow and final rounding-dust sweeping waits until all participants claim.
- For the initial testnet phase, the confirmed owner wallet `0x3d3724d20d9d5db5a40819869057b37465a0c67d` is validator 1. The other approved validator wallets are `0xb94185491c78e7331c5d53e9b0df74970b3c9b8a` and `0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01`. The legacy oracle-resolver role is retained for compatibility but cannot authorize outcome resolution. Deployment guards require the confirmed owner as both owner and deployer signer, enforce Treasury and validator-pool addresses, verify USDC decimals on-chain, and configure the three-validator roster before any market can be created.

## Critical review items before deployment

This is an initial implementation, not audited or production-ready. Remaining review items include broader insolvency/accounting invariants, no-winner edge cases across larger participant sets, reentrancy, and role coverage. The validator roster is fixed and cannot be rotated after configuration; plan a safe governance/rotation mechanism before any real-value deployment. A matching evidence hash proves only that validators submitted identical bytes, not that the underlying source is truthful. Require public evidence, independent review, and a security audit before real-value deployment.

**Never deploy with real funds.** Confirm the official Asset Chain Enugu testnet USDC contract and its decimals before deployment. Do not guess token addresses or use mainnet tokens. Do not commit private keys. Network defaults: Enugu RPC `https://enugu-rpc.assetchain.org`, chain ID `42421`.

## Local use

From this directory:

```sh
npm install
npm test
npm run compile
```

Deployment is intentionally not automatic. Verify the USDC contract, owner, Treasury, validator reward pool, and resolver addresses before running the deployment script.
