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
- Candidate approval endpoint: one approval from the configured admin or either of two configured market makers moves the candidate to `APPROVED_FOR_PUBLICATION`; duplicate approvals from the same wallet are idempotent.
- PostgreSQL persistence for candidate proposals, immutable initial evidence, distinct later observations, raw provider payloads, and retrieval timestamps.
- Independent `automation_price_observations` history for resolution-time evidence, with bounded-tolerance queries that do not silently select a distant observation.
- PostgreSQL session advisory lock to prevent scheduled discovery/capture passes from running concurrently across backend instances.
- A pure settlement evidence evaluator that enforces source/metric/asset matching, an explicit bounded observation tolerance, time validity, and a fail-closed manual-review result for missing or conflicting outcomes. It creates a deterministic SHA-256 evidence hash but does not submit an on-chain outcome.
- Separate periodic evidence capture (`MARKET_AUTOMATION_CAPTURE_INTERVAL_MINUTES`, default 5 minutes, bounded to 1–60) from candidate discovery (default 180 minutes). Both remain opt-in behind the existing feature flags.
- Integration tests against an isolated PostgreSQL test database in CI.
- Discovery is gated by `MARKET_AUTOMATION_ENABLED=true`; the gate is off unless explicitly set. Asset IDs must come from `MARKET_AUTOMATION_COINGECKO_ASSETS` in production.

## Current limitations

- The approval endpoint currently marks a candidate ready for publication; it does not submit an on-chain transaction. End-to-end publication remains blocked on a verified, authorized transaction path and must not be represented as published until the existing publication-verification route confirms the transaction.
- The settlement evaluator is implemented and unit-tested, but the scheduled settlement orchestrator and authorized on-chain validator-consensus submission are not implemented. No outcome is submitted on-chain by this workflow.
- Periodic evidence capture now records observations, but it does not guarantee an observation exactly at the future resolution timestamp. A product-approved observation window/tolerance and adequate capture cadence are still required before price markets can be safely published or resolved. Missing/out-of-window observations must remain unresolved.
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
- `POST /api/automation/candidates/:id/approve`: approve with a verified wallet session. Requires `ADMIN_WALLET_ADDRESS` and exactly two distinct `MARKET_MAKER_WALLET_ADDRESSES`.

The settlement evaluator is a library entry point (`evaluateSettlementEvidence`) for orchestration/tests, not a public API or transaction submitter. The caller must supply the approved observation tolerance; missing, stale, out-of-window, wrong-asset, or conflicting evidence returns `MANUAL_REVIEW`.

Additional scheduler settings:

- `MARKET_AUTOMATION_SCHEDULE_ENABLED=true` enables scheduled discovery/capture only when `MARKET_AUTOMATION_ENABLED=true`.
- `MARKET_AUTOMATION_INTERVAL_MINUTES` controls candidate discovery (default 180, bounded to 5–1440).
- `MARKET_AUTOMATION_CAPTURE_INTERVAL_MINUTES` controls evidence capture (default 5, bounded to 1–60). Respect provider rate limits when configuring it.

Protected endpoints require the existing wallet session token in `Authorization: Bearer <token>` and the configured owner wallet address. Discovery is proposal-only and cannot publish a market.
