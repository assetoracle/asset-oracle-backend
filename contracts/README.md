# Asset Oracle Contracts

This workspace is isolated under `contracts/` so the existing frontend and API package manifests remain unchanged.

## Current scope

- Solidity 0.8.28, OpenZeppelin access control, SafeERC20 and reentrancy protection.
- **Stablecoin allowlist:** the contract accepts only USDC, USDT, and cNGN. The initial Enugu testnet deployment enables USDC only at `0xc33741fddEBeA854d265db6F9707900Efb0211a2`; USDT and cNGN remain disabled until their Enugu token addresses and decimals are independently verified and configured. Stablecoin configuration locks when the first market is created, so any additional approved token must be verified and configured before the first market. No other token can be enabled.
- Separate manual market-creator and automated market-creator roles, plus a fixed roster of three outcome validators. The roster must be configured before the first market and contains three distinct wallets. Two validators must independently submit the same outcome and evidence hash for resolution; one vote is insufficient. Dispute adjudication uses the same 2-of-3 rule. The legacy oracle-resolver role remains for compatibility but does not authorize outcome resolution.
- Binary YES/NO stakes held in contract escrow.
- All trading-fee revenue (0.25%) goes to Treasury, including any allocation previously described as market incentives. Successful-settlement fees are 10%, split 15% to the validator reward pool and 85% to Treasury. The split applies to the settlement fee, not the separate no-winner refund policy.
- Invalid/cancelled markets have a 0% settlement fee and allow users to recover their net stake. Anyone can close a market once its staking deadline has passed, preventing abandoned open markets from trapping participant funds; before the deadline, closure is rejected.
- **Confirmed no-winner policy:** refund 75% of each participant's net stake and retain 25% of the market's total net stake for Treasury. The Validator Reward Pool receives nothing from a no-winner market. After every participant claims, any leftover token-unit rounding remainder is also sent to Treasury.
- Resolution evidence hash and a challenge window are recorded before finalization.
- A valid participant dispute enters arbitration and does not immediately unlock refunds. Two of the three configured validators must agree on the replacement outcome and evidence hash, which restarts the challenge window. If arbitration is not completed within seven days, anyone can unlock participant refunds.
- Successful settlements count unique participants and their claims. Once every participant claims, any rounding remainder after user payouts and the 10% settlement fee is sent to Treasury and emitted as `SettlementDustSwept`. Non-participants cannot call `claim` to affect this accounting. There is deliberately no expiry that forfeits an unclaimed participant payout: if any participant does not claim, their owed payout remains in escrow and final rounding-dust sweeping waits until all participants claim.
- The fixed testnet validator roster is: owner/validator 1 `0x3d3724d20d9d5db5a40819869057b37465a0c67d`, validator 2 `0xb94185491c78e7331c5d53e9b0df74970b3c9b8a`, validator 3 `0xb23c61d8506d1cfbc27d56834e6d684b8ee24f01`. The roster cannot be rotated under the current design; governance/rotation must be addressed before real-value deployment.

## Secure Enugu deployment model

The deployment script uses a **dedicated deployment wallet** as temporary contract owner and separately configures a dedicated automation wallet with both manual and automated market publication roles. It configures the approved USDC token, fixed validator roster, resolver and optional creators, verifies the configuration with read-only contract calls, then transfers ownership to the confirmed main owner wallet `0x3d3724d20d9d5db5a40819869057b37465a0c67d`. It checks that the main owner has admin, market-creator, automated-market-creator and resolver roles; the dedicated automation wallet has both publication roles; and the temporary deployer has lost all operational roles.

The GitHub deployment workflow is manual-only, restricted to `main`, and requires the explicit `confirm_new_contract_deployment=true` dispatch input. It compiles and runs the contract test suite before broadcasting. Configure `AUTOMATION_WALLET_ADDRESS` as an environment variable in the `enugu-testnet-deploy` GitHub Environment and keep `ENUGU_DEPLOYER_PRIVATE_KEY` as an environment secret. Do not run the workflow until the integration PR is merged and the deployment gate is approved.

- `DEPLOYER_PRIVATE_KEY` must belong to a dedicated, low-balance Enugu testnet deployment wallet, **not** the main owner wallet.
- Never put a private key or recovery phrase in source code, chat, a committed file, CI logs, or an ordinary repository secret.
- Keep the deployment wallet key outside source control, in a protected local/ephemeral environment. Do not put the main owner key into GitHub Actions secrets. Avoid running unreviewed workflow code with any signing key available.
- Keep control of the temporary deployer key until final ownership and role checks have passed. If the script fails after contract creation but before ownership transfer, that wallet remains owner and may be required for recovery.
- A deployment is not authorized merely because this script exists. Compile, test, inspect the exact parameters and transaction implications, then obtain explicit approval before any on-chain deployment.
- After deployment, set `ASSET_ORACLE_MARKET_MANAGER_ADDRESS` only to the independently verified new address and set `AUTOMATION_WALLET_ADDRESS` to the dedicated worker wallet. Run `npm run preflight:enugu`. The read-only preflight checks chain ID, token bytecode/decimals, exact manager runtime bytecode, owner, Treasury, validator pool, USDC configuration, all three validators, both automation wallet roles, and the 10% settlement fee with a 15% validator / 85% Treasury split.

## Critical review items before deployment

This is an initial implementation, not audited or production-ready. Remaining review items include broader insolvency/accounting invariants, no-winner edge cases across larger participant sets, reentrancy, and role coverage. A matching evidence hash proves only that validators submitted identical bytes, not that the underlying source is truthful. Require public evidence, independent review, and a security audit before real-value deployment.

**Never deploy with real funds.** Confirm the official Asset Chain Enugu testnet USDC contract and its decimals before deployment. Do not guess token addresses or use mainnet tokens. Do not commit private keys. Network defaults: Enugu RPC `https://enugu-rpc.assetchain.org`, chain ID `42421`.

## Local use

From the `contracts/` directory:

```sh
npm install
npm test
npm run compile
```

Deployment is intentionally not automatic. Verify the USDC contract, owner, Treasury, validator reward pool, and resolver addresses before running the deployment script.
