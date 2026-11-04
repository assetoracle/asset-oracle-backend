# Testnet market lifecycle automation

This worker is intentionally limited to Asset Chain Enugu testnet (chain ID 42421) and the newly deployed manager address supplied through `ASSET_ORACLE_MARKET_MANAGER_ADDRESS`. The address remains unset until the new contract deployment is verified; the previous manager is not used.

## What it automates

- Publishes only manual proposals approved by an authorized owner/market maker and automated proposals approved through the private market-maker review flow.
- Records publication only after a successful transaction receipt and a matching `MarketCreated` event.
- Closes markets whose on-chain close time has passed.
- Marks unresolved closed markets refundable after the contract timeout.
- Marks unresolved arbitration markets refundable after the existing seven-day dispute timeout.
- Calls `finalizeMarket` only after the existing 2-of-3 validator process has resolved a market and its challenge period has elapsed.
- Processes eligible payouts in contract-supported batches of up to 50 participants, with database progress tracking and a per-run batch limit.

It never chooses an outcome, generates validator votes, or bypasses the validator consensus/dispute rules.

## GitHub Actions scheduled runner

The repository workflow `.github/workflows/testnet-market-lifecycle.yml` runs the existing standalone worker directly on a GitHub-hosted runner. No Render service or trigger endpoint is required.

- Repository: `https://github.com/assetoracle/asset-oracle-backend`
- Branch: `main` only
- Runtime: Node.js 22
- Install: `npm install --include=dev`
- Build: `npm run build`
- Worker: `npm run automate:market-lifecycle`
- Schedule: `*/10 * * * *` (every ten minutes, UTC)
- Network: Asset Chain Enugu testnet (chain ID 42421)

### Required GitHub configuration

Create a GitHub Environment named `asset-oracle-testnet` under **Settings → Environments**. Restrict deployment branches to `main`.

Add these **environment secrets** directly in GitHub. Never paste their values into chat or commit them:

- `DATABASE_URL`: connection string for the dedicated Neon **staging** database only. Do not use the production database.
- `AUTOMATION_PRIVATE_KEY`: a dedicated, low-balance testnet automation wallet key. Never use an owner, validator, personal, or mainnet wallet key.

Add these **environment variables** to the same `asset-oracle-testnet` environment after the new deployment is verified:

- `ASSET_ORACLE_MARKET_MANAGER_ADDRESS`: the newly deployed contract address only.
- `ASSET_ORACLE_NEW_CONTRACT_VERIFIED`: set to `true` only after `npm run preflight:enugu` confirms the deployed runtime bytecode, owner, validator roster, USDC configuration, automation roles, and 10% / 15-85 fee policy. Keep it false otherwise.
- `AUTOMATION_WALLET_ADDRESS`: the public address derived from `AUTOMATION_PRIVATE_KEY`; it must match exactly.

The RPC URL, chain ID, and explorer are configured in the workflow. The workflow remains dormant until the repository variable `ENABLE_TESTNET_AUTOMATION` is set to `true` under **Settings → Secrets and variables → Actions → Variables**.

Do not enable that variable until the staging database connection, wallet role, wallet testnet gas, and on-chain preflight checks have all been verified. The workflow must be merged into `main` before its scheduled trigger can run.

### Security requirements

- Keep the repository's default branch protected. Require review for changes to workflow files and worker code; do not allow unreviewed commits to `main`.
- Environment secrets are available to workflow code running from the permitted branch. A malicious or compromised change merged to `main` could expose them. Review every change to the workflow and worker before merging.
- Use a dedicated testnet-only wallet with minimal funds and only the required `MARKET_CREATOR_ROLE` and `AUTOMATED_MARKET_CREATOR_ROLE`.
- Never configure a mainnet private key, production database URL, or real funds.
- GitHub-hosted runners are ephemeral. The worker runs as a standalone process and closes its database pool at completion.
- The PostgreSQL advisory lock prevents overlapping worker instances from submitting duplicate lifecycle actions.
- Scheduled GitHub Actions can be delayed during periods of high load. The worker is designed to be safely rerun; it is not a guaranteed exact-time scheduler.

## Preflight and safety behavior

Before opening the database lock or sending transactions, the worker requires the explicit new-contract verification flag and checks the RPC chain ID, manager bytecode, configured validator roster, USDC address/decimals, and the automation wallet's on-chain `MARKET_CREATOR_ROLE` and `AUTOMATED_MARKET_CREATOR_ROLE`. It aborts if any check fails.

Settlement automation never chooses an outcome. The 2-of-3 human validator consensus and contract challenge period remain authoritative. The current new-contract testnet build uses USDC only (stablecoin index 0); do not assume cNGN or USDT are enabled on Enugu until a separate verified deployment configuration supports them.

The proposal UUID is included in the on-chain resolution-rules JSON to support recovery after an on-chain creation succeeds but the database update is interrupted. If recovery cannot be verified, the worker stops rather than blindly creating a duplicate.

This is unaudited testnet automation. Do not configure a mainnet private key or use real funds.

## Read-only preflight before activation

After this PR is merged to `main`, keep `ENABLE_TESTNET_AUTOMATION` unset or set to anything other than `true`. Open **Actions → Testnet market lifecycle automation → Run workflow**, select `main`, and run it manually. The workflow will execute only the read-only preflight job while automation is disabled.

The preflight checks the Neon connection, testnet RPC chain ID, new market manager bytecode, configured validator roster, USDC configuration, both publication roles, and that the private key matches the dedicated automation wallet address. It also reports the wallet's native testnet gas balance. It does not acquire the lifecycle lock, read or change market proposals, sign transactions, or submit transactions.

Review the preflight output. It prints database name/user and public on-chain addresses, but never prints connection strings or private keys. Confirm that the database name corresponds to the Neon staging branch. A passing preflight is not permission to activate the recurring worker; obtain explicit approval before enabling `ENABLE_TESTNET_AUTOMATION=true`.
