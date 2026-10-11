# Asset Oracle Contracts

This workspace is isolated under `contracts/` so the existing frontend and API package manifests remain unchanged.

## Current scope

- Solidity 0.8.28, OpenZeppelin access control, SafeERC20 and reentrancy protection.
- **Enugu testnet accepts USDC only**, at `0xc33741fddEBeA854d265db6F9707900Efb0211a2`. The deployment script rejects other token addresses and configures only this token. USDC decimals default to 6 and must be verified against the token contract.
- Separate market-creator and oracle-resolver roles. Creators cannot resolve outcomes; resolvers cannot change token configuration or fee recipients.
- Binary YES/NO stakes held in contract escrow.
- Separate 0.25% trading fee and 2% successful-settlement fee. The 2% fee is split 25% to the validator reward pool and 75% to treasury.
- Invalid/cancelled markets have a 0% settlement fee and allow users to recover their net stake.
- If a validly resolved outcome has no stake on its winning side, the first-pass implementation refunds each participant's full net stake and charges no settlement fee. No amount is retained for this case.
- Resolution evidence hash and a challenge window are recorded before finalization.

## Critical review items before deployment

This is an initial implementation, not audited or production-ready. The first test pass must include insolvency/invariant tests, rounding/dust, all no-winner paths, dispute/refund semantics, challenge handling, and reentrancy/role tests. A dispute currently moves the market to the refundable state; the governance and evidence review process must be strengthened before any real-value deployment.

**Never deploy with real funds.** Confirm official Asset Chain Enugu testnet addresses and decimals for all three test stablecoins first. Do not guess token addresses or use mainnet tokens. Do not commit private keys. Network defaults: Enugu RPC `https://enugu-rpc.assetchain.org`, chain ID `42421`.

## Local use

From this directory:

```sh
npm install
npm test
npm run compile
```

Deployment is intentionally not automatic. The deploy script will be added only after the configured token addresses and owner/treasury/resolver parameters are verified.
