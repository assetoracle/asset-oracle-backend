# Legacy Market Publication Attempt Seed

This utility seeds the one-time reconciliation records for approved proposals that existed before durable publication-attempt tracking.

## Safety

- Run against the **staging** Neon branch only.
- The utility requires `ASSET_ORACLE_MIGRATION_TARGET=staging`.
- It requires `ASSET_CHAIN_ID=42421` and the verified `ASSET_ORACLE_MARKET_MANAGER_ADDRESS`.
- It does not require or read an automation private key.
- It does not create a public or wallet client, contact the chain RPC, or submit transactions.
- It does not start the lifecycle worker or enable automated market creation.
- It does not call `initializeMarketStore()`; the API must already have applied the additive schema migration.
- The command defaults to a read-only dry run. Database writes require the explicit `--apply` argument.

## Dry run

Set `DATABASE_URL` to the staging Neon connection string, then run:

```bash
ASSET_ORACLE_MIGRATION_TARGET=staging ASSET_CHAIN_ID=42421 ASSET_ORACLE_MARKET_MANAGER_ADDRESS=0x... npm run seed:legacy-publication-attempts
```

On PowerShell:

```powershell
$env:ASSET_ORACLE_MIGRATION_TARGET = "staging"
$env:ASSET_CHAIN_ID = "42421"
$env:ASSET_ORACLE_MARKET_MANAGER_ADDRESS = "0x..."
npm run seed:legacy-publication-attempts
```

Review the displayed database name, manager address, and candidate count before applying.

## Apply

After confirming the target is the staging database, append `-- --apply`:

```bash
npm run seed:legacy-publication-attempts -- --apply
```

PowerShell:

```powershell
npm run seed:legacy-publication-attempts -- --apply
```

The utility calls the existing idempotent `seedLegacyMarketPublicationAttempts` service function. It records eligible legacy proposals as `RECONCILIATION_REQUIRED`, never as `PREPARED` or `SUBMITTED`. Those proposals remain blocked from automatic republication until manually reconciled against chain history.

The migration marker is scoped to the chain ID and manager address. Re-running after a successful seed does not create another set of legacy attempts.
