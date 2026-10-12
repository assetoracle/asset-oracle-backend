# Asset Oracle mainnet readiness gate

This is a pre-deployment checklist, not authorization to deploy or publish markets.

## Current known state

- The frontend and backend are separate repositories/services. Keep the existing frontend deployment separate.
- The known Market Manager deployment is on Asset Chain Enugu testnet (chain ID 42421). It is not a mainnet deployment.
- The current backend database is expected to be configured through Render's private environment settings and Neon. Never put DATABASE_URL or other secrets in source control or chat.
- The SHALOM DEX and CoinGecko monitors are opt-in and disabled by default.
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

## Required before enabling evidence monitors

- [ ] Set `COINGECKO_MONITOR_ENABLED=true` only after backend tests pass and the observation rules are approved.
- [ ] Verify the live Asset Chain Swap SHALOM/xRWA and xRWA/USDT pools by reading their token addresses, fee tiers, active liquidity, and TWAP availability.
- [ ] Resolve the conflicting SHALOM contract references; set `SHALOM_TOKEN_ADDRESS` only after verifying the token used by the live pool.
- [ ] Set xRWA/USDT addresses and minimum active-liquidity values based on verified mainnet pool state, not guessed values.
- [ ] Confirm Neon capacity, retention, backups, and monitoring-gap alerting. The current database evidence hash is tamper-evident only if the evidence is separately retained; a hash alone is not an immutable archive.
- [ ] Do not enable either monitor until its source coverage and missing-data policy are approved.

## Required before publishing the November markets

- [ ] Approve the exact wording and provider-snapshot/TWAP sampling rules.
- [ ] Confirm BTC, ETH, and BNB source IDs and the one-minute sampled-observation rule.
- [ ] Confirm WKC token/project, contract address, CoinGecko asset ID, and circulating-market-cap methodology.
- [ ] Confirm SHALOM token identity, pool route, minimum liquidity, slippage/manipulation policy, and source-failure handling.
- [ ] Ensure the monitoring window begins before the market opens and the monitor is demonstrably healthy.
- [ ] Publish each market only after owner authorization, mainnet deployment/configuration, and a confirmed on-chain creation receipt.

## Explicit approval gates

No mainnet deployment, production environment change, monitor enablement, contract transaction, or market publication should be performed merely because this checklist is complete. Each requires the project owner's explicit authorization at that stage.
