# API market-creation automation — Phase 1

## Scope

This phase implements **proposal-only market discovery** using CoinGecko as the first provider. It does not call the market manager contract, publish markets, manage signing keys, cast validator votes, or settle markets.

## Current behavior

- Manual admin-only discovery through `POST /api/automation/candidates/run`; no scheduler is configured.
- Admin candidate listing through `GET /api/automation/candidates`, with optional status and limit filters.
- Admin review through `POST /api/automation/candidates/:id/review`: `DISMISS` and `RESTORE` transitions are audited with the admin wallet and a required reason.
- Feature flag `MARKET_AUTOMATION_ENABLED` is off unless set to the exact string `true`.
- `MARKET_AUTOMATION_COINGECKO_ASSETS` is a comma-separated CoinGecko asset-ID allowlist. Discovery requests cannot select assets outside it.
- `COINGECKO_API_KEY` is optional for the provider's configured API tier.
- Candidate proposals and initial evidence are persisted in PostgreSQL. A unique deterministic key prevents repeated runs from creating duplicate candidate rows; repeat observations update only `last_seen_at`, not the original proposal/evidence. Each distinct observation is also appended to `automation_candidate_observations` with provider, metric, asset, source timestamp, value, currency, source URL, and server recording time; exact repeated `(candidate, observed_at, value)` observations are deduplicated.
- Proposals are checked with the existing market proposal schema. Provider evidence must be valid, positive, and recent.
- This is a candidate-generation policy only. The current threshold and timing defaults need product approval before any scheduled worker or publisher is considered.

## API authentication

Protected endpoints require the existing wallet session token in `Authorization: Bearer <token>` and the configured owner wallet address in the request/query `address` field. The address must also pass the backend's existing admin wallet allowlist check.

## Verification and safety boundary

- API discovery is evidence for a human-reviewed candidate, not validator consensus.
- No publisher, cron/scheduler, signing-key integration, automatic settlement, or liquidity workflow is implemented in this phase.
- Do not enable production discovery until asset policy, rate limiting/retries, monitoring, database failure behavior, and isolated PostgreSQL integration tests have been reviewed. The observation history is currently persisted separately from the immutable initial candidate basis; this should be verified against an isolated test database before enabling production discovery.
- Before a separate publishing phase, verify the deployed Enugu manager address and bytecode/source, creator role, validator roster, enabled stablecoins, and RPC chain ID from live chain reads.
- Any future publisher must use the existing contract and preserve its validator-consensus/evidence-hash rules. No contract change or on-chain transaction is part of this phase.
