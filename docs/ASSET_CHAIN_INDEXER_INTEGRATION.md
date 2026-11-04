# Asset Chain indexer integration plan

## What exists today

The backend currently contains `src/services/onchainStatsIndexer.ts`. It is a persistent Asset Oracle manager-contract event indexer, not a full Asset Chain block/transaction indexer. It reads confirmed logs through the Enugu RPC, stores events and cursors in the existing PostgreSQL database, and exposes aggregate dashboard/wallet history data.

The separate SubQuery starter workflow discussed for Asset Chain Enugu used:
- Chain ID: `42421`
- RPC: `https://enugu-rpc.assetchain.org`
- Local GraphQL endpoint during development: `http://localhost:3000/`
- Starter template: `asset-chain-testnet-starter`
- SubQuery Managed Service authentication variable: `SUBQL_ACCESS_TOKEN`

No deployed hosted GraphQL endpoint, SubQuery project ID, or mapping/schema definition was verified in the available repository at the time of this change. Do not invent an endpoint or query field names.

## Current changes in this branch

- The manager event indexer no longer imports or scans retired manager addresses.
- It requires `ASSET_ORACLE_INDEXER_CONTRACT_ADDRESS` and `ASSET_ORACLE_INDEXER_START_BLOCK`, both to be supplied only after the new manager is deployed.
- It indexes the known `MarketCreated` and `MarketClosed` lifecycle events in addition to `Staked`, `MarketFinalized`, `Claimed`, and `Refunded`.
- It retains batched RPC reads, confirmation depth, a persistent cursor, transaction/log deduplication, and transactional database writes.
- Dashboard statistics and wallet history no longer automatically append legacy manager addresses.
- The lifecycle worker now requires an explicit `ASSET_ORACLE_MARKET_MANAGER_ADDRESS`; it no longer obtains a manager address from a hardcoded retired deployment.
- The indexer and lifecycle automation remain disabled until the new deployment is ready. No transactions are submitted by this branch.

## What is needed to connect the full Asset Chain indexer

The full-chain SubQuery service should remain the source for chain-wide blocks, transactions, receipts, wallet activity, transfers and contract events. Asset Oracle should consume its indexed GraphQL data rather than create a second full-chain scanner.

Before writing schema-specific GraphQL operations, obtain and verify:
1. The deployed SubQuery GraphQL endpoint URL.
2. The SubQuery project/deployment name and network (Enugu testnet, chain ID 42421).
3. The GraphQL schema or generated query types for the indexed entities.
4. Whether the deployment indexes blocks, transactions, receipts, native/token transfers and logs, and its starting block/finality policy.
5. The access method. Keep `SUBQL_ACCESS_TOKEN` server-side only if the endpoint requires it.

Once these are available, add a backend-only SubQuery client with bounded timeouts, pagination, retry/backoff for transient errors, schema-aware validation, and checkpoint tracking. Persist only Asset Oracle's required normalized evidence in the existing database; do not duplicate the full chain dataset. Reconcile returned transaction hashes and block heights against the Enugu RPC for critical records.

## New manager deployment boundary

The new manager contract has not yet been deployed. Its address, ABI and deployment block must not be guessed. After deployment, provide the verified manager address, ABI and block number as configuration. Then enable the contract-event indexer and lifecycle automation only after read-only preflight and testnet review.

## Safety requirements

- No old manager address or legacy-funds migration is part of this integration.
- Do not enable the indexer or lifecycle automation during development.
- External API evidence and indexed chain data do not decide market outcomes. Human-validator consensus and the new contract remain authoritative.
- Keep using the existing PostgreSQL database; this plan does not introduce a replacement database.
