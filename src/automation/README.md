# Asset Oracle automation — staged implementation

## Goal

Build one shared automation infrastructure with two independently testable workflows:

1. **Market creation:** discover data-backed market opportunities, validate the question and resolution rule, persist evidence, prevent duplicates, then publish only through an explicitly authorized path that respects the existing contract.
2. **Market settlement:** detect closed markets, collect timestamped resolution evidence, apply the market's published rule, preserve evidence/audit history, and submit outcomes only through the existing validator-consensus process.

The workflows share provider adapters, evidence storage, retry policy, audit logging, and monitoring. They must not share a single failure boundary: settlement must not depend on a new market being generated in the same run.

## Implemented on this feature branch

- CoinGecko USD price adapter with response validation, freshness checks, bounded retries, and retryable error handling.
- Deterministic proposal candidate generation using the existing market proposal schema.
- Admin-authenticated discovery, candidate listing, and audited dismiss/restore review endpoints.
- PostgreSQL persistence for candidate proposals, immutable initial evidence, distinct later observations, and review events.
- Integration tests against an isolated PostgreSQL test database in CI.
- Discovery is gated by `MARKET_AUTOMATION_ENABLED=true`; the gate is off unless explicitly set. Asset IDs must come from `MARKET_AUTOMATION_COINGECKO_ASSETS` in production.

## Current limitations

- This is not yet end-to-end automatic market creation: it generates and stores reviewable candidates, but has no publisher or scheduler.
- Automatic settlement has not yet been implemented.
- The current CoinGecko spot-price response is not sufficient by itself to prove a price at a future, exact resolution timestamp. A timestamped observation-capture and missing-evidence policy must be designed and tested before any price market is publishable or automatically resolvable.
- Candidate threshold/timing defaults are engineering placeholders, not approved production market policy.
- No liquidity/market-making workflow is included.

## Safety and rollout

- Keep work on `feat/api-market-creation-automation` and keep PR #53 a draft until both workflows and their end-to-end tests are complete.
- Do not merge or deploy during development. Do not change live environment flags as a substitute for implementation or testing.
- Do not add contract changes, private-key handling, or direct signer shortcuts. Any future on-chain action must use the existing contract and preserve its authorization, validator-consensus, and evidence-hash requirements.
- Before a publisher or settlement submitter is added, verify live Enugu testnet contract bytecode/source, manager address, creator permissions, validator roster, supported stablecoins, and chain ID through read-only chain checks.
- Missing, stale, delayed, or conflicting evidence must fail closed and leave a market unresolved for review; never infer an outcome from absent data.
- Keep market creation, settlement, and liquidity as separate scopes.

## Existing admin API

- `POST /api/automation/candidates/run`: manually run candidate discovery.
- `GET /api/automation/candidates`: list stored candidates.
- `POST /api/automation/candidates/:id/review`: dismiss or restore a candidate with an audit reason.

Protected endpoints require the existing wallet session token in `Authorization: Bearer <token>` and the configured owner wallet address. Discovery is proposal-only and cannot publish a market.
