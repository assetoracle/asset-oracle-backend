# Asset Oracle Contracts

This workspace is isolated under `contracts/` so the existing frontend and API package manifests remain unchanged.

## Current scope

- Solidity 0.8.28, OpenZeppelin access control, SafeERC20 and reentrancy protection.
- **Enugu testnet accepts USDC only**, at `0xc33741fddEBeA854d265db6F9707900Efb0211a2`. The deployment script rejects other token addresses and configures only this token. USDC decimals default to 6 and must be verified against the token contract.
- Separate market-creator and oracle-resolver roles. Creators cannot resolve outcomes; resolvers cannot change token configuration or fee recipients.
- Binary YES/NO stakes held in contract escrow.
- All trading-fee revenue (0.25%) goes to Treasury, including any allocation previously described as market incentives. Successful-settlement fees are 2%, split 25% to the validator reward pool and 75% to Treasury.
- Invalid/cancelled markets have a 0% settlement fee and allow users to recover their net stake.
- **No-winner policy is not approved yet.** The inherited contract currently refunds 75% of each participant's net stake and retains 25% of the market's net stake for Treasury; confirm whether this policy or a full 0%-fee refund is intended before treating it as final.
- Resolution evidence hash and a challenge window are recorded before finalization.
- A valid participant dispute enters an arbitration state; it does not immediately unlock refunds. The owner must record a replacement outcome and evidence, which restarts the challenge window. If arbitration is not completed within seven days, anyone can unlock participant refunds.
- Successful settlements count unique participants and their claims. Once every participant claims, any rounding remainder after user payouts and the 2% settlement fee is sent to Treasury and emitted as `SettlementDustSwept`. Non-participants cannot call `claim` to affect this accounting.
- Deployment guards require the confirmed owner wallet `0xa785ceba7db4ec6326d63783a896f15824009b17` as both configured owner and deployer signer, enforce the confirmed Treasury and validator pool addresses, and verify USDC decimals on-chain before deployment.

## Critical review items before deployment

This is an initial implementation, not audited or production-ready. Remaining review items include broader insolvency/accounting invariants, the unresolved no-winner policy and its rounding behavior, reentrancy, and role coverage. Dispute adjudication is owner-controlled and therefore centralized; define an independent arbitration/governance model before any real-value deployment.

**Never deploy with real funds.** Confirm the official Asset Chain Enugu testnet USDC contract and its decimals before deployment. Do not guess token addresses or use mainnet tokens. Do not commit private keys. Network defaults: Enugu RPC `https://enugu-rpc.assetchain.org`, chain ID `42421`.

## Local use

From this directory:

```sh
npm install
npm test
npm run compile
```

Deployment is intentionally not automatic. Verify the USDC contract, owner, Treasury, validator reward pool, and resolver addresses before running the deployment script.
