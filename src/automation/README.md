# API market-creation automation — Phase 1

## Scope

This module begins the API-based market creation workflow using CoinGecko as the first provider. It is deliberately proposal-only: it creates candidate data in memory for validation and review. It does not call the contract, publish markets, manage signing keys, cast validator votes, or settle markets.

## Current boundary

- Use CoinGecko USD spot-price observations only.
- Reject malformed, non-positive, stale, or future-dated observations.
- Generate a deterministic candidate key so persistence can deduplicate retries.
- Pass generated proposals through the existing market proposal schema.
- Keep provider evidence and a basic quality explanation attached to each candidate.
- Keep the module isolated so it can be disabled or removed without changing existing market, staking, fee, refund, or settlement paths.

## Before enabling a scheduled worker

1. Add a persistent candidate table with a unique constraint on the candidate key and immutable provider evidence.
2. Add an authenticated admin review surface and metrics for provider errors, stale observations, duplicates, and candidate counts.
3. Add a disabled-by-default feature flag and a dry-run mode.
4. Add retry/backoff with a bounded retry budget and respect provider rate limits.
5. Confirm the deployed Enugu contract address, bytecode/source match, creator role, configured validator roster, and USDC configuration from chain reads.
6. Test provider timeouts, 429/5xx responses, duplicate runs, database failures, malformed payloads, and restart recovery.
7. Only after those checks pass should a separately approved phase add a restricted publisher. The publisher must verify transaction receipts and the MarketCreated event and reconcile idempotently before recording a publication.

## Deliberate limitations

The generated price-threshold question is a starter candidate policy, not a claim that all such markets are desirable. Before enabling a worker, product policy must approve which assets, thresholds, cadence, market lifetime, and candidate volume are permitted. API data is evidence for a candidate, not on-chain validator consensus.
