# Asset Oracle mainnet readiness gate

This is a pre-deployment checklist, not authorization to deploy or publish markets.

## Current known state

- The frontend and backend are separate repositories/services. Keep the existing frontend deployment separate.
- The known Market Manager deployment is on Asset Chain Enugu testnet (chain ID 42421). It is not a mainnet deployment.
- The current backend database is expected to be configured through Render's private environment settings and Neon. Never put DATABASE_URL or other secrets in source control or chat.
- CoinGecko price monitoring and SHALOM DEX monitoring are being removed. Outcome verification is intended to be human-validator-led until a future CRE integration is ready.
- Market proposal documentation is not proof of a created market. A market is published only after a successful on-chain transaction receipt, confirmed market ID, and backend publication record.

## Required before any mainnet deployment

- [ ] Identify and review the exact Solidity source for the Market Manager and related contracts. The frontend repository currently contains the ABI/integration code, not the full deployment source.
- [ ] Confirm source code matches the deployed Enugu contract and record compiler version, optimizer settings, constructor arguments, and deployment bytecode.
- [ ] Complete independent security review of market creation, token allowlist, escrow, refunds, invalid-market handling, settlement fees, treasury/validator distributions, disputes, and access controls.
- [ ] Confirm mainnet contract addresses and decimals for the only permitted staking/settlement assets: cNGN, USDT, and USDC. Do not copy Enugu test token addresses to mainnet.
- [ ] Confirm mainnet owner/resolver, treasury, validator reward pool, and emergency/admin controls with the project owner.
- [ ] Validate chain ID, RPC, explorer, deployment transaction, verified source, and contract read-back before changing any frontend/backend configuration.
- [ ] Run tests against a fork or test deployment, including YES, NO, INVALID, cancelled/refunded, no-winner, dispute, and fee-distribution paths.
- [ ] Prepare rollback and pause procedures, event monitoring, and database backup/restore steps.

## Human-validator resolution requirements

- [ ] Configure exactly three authorized validator wallets after the project owner confirms all addresses.
- [ ] Enforce 2-of-3 matching votes in the smart contract; backend-only checks are insufficient.
- [x] Specify the current vote policy: each validator may vote once per market; conflicting votes do not resolve it; 2-of-3 must match outcome and evidence hash; INVALID is supported; unresolved closed markets and uncompleted disputes use the contract timeout/refund paths.
- [x] Add tests for unauthorized wallets, duplicate votes, disagreement, consensus, dispute handling, and settlement/refunds.
- [ ] Add off-chain notifications for markets awaiting validator review; notifications must not themselves authorize settlement.
- [ ] Design safe validator roster rotation/governance before real-value deployment; the current roster is fixed once configured.
- [x] Keep CRE integration as a later phase; it is not required for current human-led resolution.

## Required before publishing the proposed November markets

- [ ] Approve exact question wording, deadline, timezone, resolution methodology, and acceptable public evidence for each market.
- [ ] Define how validators establish BTC, ETH, and BNB prices at the deadline using independent, timestamped public sources; do not rely on the removed CoinGecko polling monitor.
- [ ] Confirm the exact WKC project/token identity, official contract address, market-cap methodology, and public evidence sources.
- [ ] Confirm the exact SHALOM token identity and define the price evidence methodology without restoring the removed DEX monitor.
- [ ] Ensure all three validators can independently access and archive the evidence; document what happens if sources disagree or are unavailable.
- [ ] Publish each market only after owner authorization, approved contract deployment/configuration, and a confirmed on-chain creation receipt.

## Explicit approval gates

No mainnet deployment, production environment change, monitor enablement, contract transaction, or market publication should be performed merely because this checklist is complete. Each requires the project owner's explicit authorization at that stage.
