# Testnet market lifecycle automation

This worker is intentionally limited to Asset Chain Enugu testnet (chain ID 42421) and the canonical market manager configured in `src/config/assetOracle.ts`.

## What it automates

- Publishes only proposals that an admin has already approved in the backend database.
- Records publication only after a successful transaction receipt and a matching `MarketCreated` event.
- Closes markets whose on-chain close time has passed.
- Calls `finalizeMarket` only after the existing 2-of-3 validator process has resolved a market and its challenge period has elapsed.

It never chooses an outcome, generates validator votes, or bypasses the validator consensus/dispute rules. Markets in arbitration are left alone.

## Required Render Cron Job configuration

Create a **Cron Job** in the same Render workspace after this branch has been reviewed and merged:

- Repository: `https://github.com/assetoracle/asset-oracle-backend`
- Branch: the reviewed default branch after merge
- Runtime: Node
- Build command: `npm install --include=dev && npm run build`
- Start command: `npm run automate:market-lifecycle`
- Schedule: `*/5 * * * *` (every five minutes)
- Region: Oregon (same region as the current backend)

Required environment variables:

- `DATABASE_URL`: use the existing backend database connection string, entered via Render's secret environment variable UI.
- `AUTOMATION_PRIVATE_KEY`: a **dedicated testnet-only wallet key**, entered as a secret. Do not reuse a personal wallet, owner wallet, validator wallet, or any mainnet key.
- `ASSET_CHAIN_RPC_URL`: `https://enugu-rpc.assetchain.org`
- `ASSET_CHAIN_ID`: `42421`
- `ASSET_CHAIN_EXPLORER_URL`: `https://scan-testnet.assetchain.org`

The automation wallet must be explicitly granted `MARKET_CREATOR_ROLE` on the canonical testnet manager and funded with testnet gas only. Before enabling this cron job, verify the current manager bytecode, stablecoin 0 configuration (USDC, 6 decimals), validator roster, role grant, and deployment evidence. The worker aborts if its on-chain preflight fails.

## Safety notes

- The worker checks the RPC chain ID, manager bytecode, configured validator roster, USDC address/decimals, and the automation wallet's on-chain role before sending transactions.
- A PostgreSQL advisory lock prevents overlapping worker runs.
- The proposal UUID is included in the on-chain resolution-rules JSON to allow recovery after a successful create transaction whose database update was interrupted. If event recovery fails, the worker stops rather than blindly creating a duplicate.
- RPC/provider limits may prevent scanning old logs for recovery. In that case, the worker intentionally stops and requires manual reconciliation.
- This is unaudited testnet automation. Do not configure a mainnet private key or use real funds.
- The current backend Render service has auto-deploy disabled. Creating this file/branch does not deploy or enable the worker.
