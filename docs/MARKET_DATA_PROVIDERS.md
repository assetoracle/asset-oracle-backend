# Asset Oracle market data providers

Backend-only provider clients and admin-authenticated routes. Provider credentials are read from backend environment variables and are never sent to the browser. These integrations collect source evidence; they do not select market outcomes or authorize settlement.

## Approved provider coverage

| Segment | Provider | Status / purpose |
|---|---|---|
| Digital Assets | CoinGecko | Active; target-coin market data and token metadata by CoinGecko coin ID |
| Digital Assets | DexScreener | Active; DEX token pairs, prices, liquidity and volume |
| Digital Assets | FireScreener | Reserved; pending official API availability, no scraping or guessed endpoints |
| RWA | DeFiLlama | Implemented; protocol TVL and DEX overview |
| RWA | DexScreener | Implemented; token pair and liquidity discovery |

| Economic & financial | FRED | Implemented; series observations |
| Economic & financial | World Bank | Implemented; country indicator observations |
| Regional & global events | GDELT | Implemented; article discovery |
| Regional & global events | Open-Meteo | Implemented; historical weather observations |
| Sports | Sportmonks | Implemented; fixtures by date |
| Sports | API-Football | Implemented; fixtures by date, optional league and season |

## Category-scoped provider dispatch

Market processing must select providers from the market's own category before making any external request. The selector in `src/services/marketProviderRouter.ts` enforces this allowlist:

| Market category | Eligible providers |
|---|---|
| Digital Assets | CoinGecko, DexScreener |
| RWA | DeFiLlama, DexScreener |
| Sports | Sportmonks, API-Football |
| Economics | FRED, World Bank |
| Regional | GDELT, Open-Meteo |

A market with a configured `resolutionRule.sourceId` narrows execution to that single provider, and a provider outside the category allowlist is rejected. Proposal validation also requires provider-specific query parameters (for example a CoinGecko coin ID, FRED series ID, or sports fixture date). `collectMarketEvidence(proposalId)` loads one approved proposal, applies the selector, calls only its configured provider and persists the raw response, retrieval timestamp, SHA-256 hash, metric value (when its configured path exists), and `UNREVIEWED` status. Duplicate provider responses are idempotently ignored. No global provider fan-out occurs.

## Admin API routes

All routes require a valid wallet session in the `Authorization: Bearer <session-token>` header and an admin wallet `address` in the JSON body.

| Method and path | Additional body fields |
|---|---|
| POST `/api/data-sources/coingecko/markets` | optional `vsCurrency`, `page`, `perPage` |
| POST `/api/data-sources/dexscreener/search` | `query` |
| POST `/api/data-sources/dexscreener/token-pairs` | `chain`, `tokenAddress` |
| POST `/api/data-sources/defillama/protocols` | none |
| POST `/api/data-sources/defillama/tvl` | `protocol` |
| POST `/api/data-sources/sports/sportmonks/fixtures` | `date` (YYYY-MM-DD) |
| POST `/api/data-sources/sports/api-football/fixtures` | `date` (YYYY-MM-DD), optional `league`, `season` |
| POST `/api/data-sources/economics/fred` | `seriesId`, optional `start`, `end` |
| POST `/api/data-sources/economics/world-bank` | `country`, `indicator`, optional `dateRange` |
| POST `/api/data-sources/regional/gdelt` | `query`, optional `maxRecords` |
| POST `/api/data-sources/regional/open-meteo/historical` | `latitude`, `longitude`, `startDate`, `endDate` |

Provider results include provider, source URL, retrieval timestamp and SHA-256 response hash. API credentials are sent in request headers where supported; FRED's query-string key is redacted from returned source references. This metadata helps trace evidence but does not itself prove an outcome.

## Market evidence API

The following endpoints are admin-wallet/session protected:

- `POST /api/market-evidence/:proposalId/collect` — collect one response from the proposal's configured provider and store it for review.
- `POST /api/market-evidence/:proposalId/list` — retrieve up to 100 stored evidence records for that proposal.

The evidence table is `market_data_evidence`; it is separate from `validator_source_links`, which records on-chain validator vote evidence. Provider observations are always stored as `UNREVIEWED`. The admin-triggered endpoints remain available for manual collection. A standalone category-aware worker is now available as `npm run automate:market-evidence`. It processes only approved proposals whose resolution time is still in the future, uses each proposal's configured provider, skips proposals whose last collection attempt is still within the freshness interval, and uses a PostgreSQL advisory lock to prevent overlapping runs. Collection attempts are tracked separately from evidence records, so unchanged provider responses and failed requests do not trigger an API call on every scheduler tick. It never fans out across all providers. The worker is disabled unless `MARKET_EVIDENCE_WORKER_ENABLED=true`; it is not scheduled or enabled by this code change.

Worker configuration:

- `MARKET_EVIDENCE_WORKER_ENABLED=false` by default.
- `MARKET_EVIDENCE_MAX_PER_RUN=10` maximum due proposals processed per run (bounded to 1–50).
- `MARKET_EVIDENCE_INTERVAL_MINUTES=15` default freshness interval.
- Optional category overrides: `MARKET_EVIDENCE_DIGITAL_ASSETS_INTERVAL_MINUTES (legacy CRYPTO variable remains supported)`, `MARKET_EVIDENCE_RWA_INTERVAL_MINUTES`, `MARKET_EVIDENCE_SPORTS_INTERVAL_MINUTES`, `MARKET_EVIDENCE_ECONOMICS_INTERVAL_MINUTES`, and `MARKET_EVIDENCE_REGIONAL_INTERVAL_MINUTES`.

Run the command from a scheduler only after provider credentials, database capacity, request quotas and the desired cadence have been reviewed. Each run is a bounded batch; no scheduler, cron job or hosted environment setting is enabled by this change.

## Backend secrets

Set these only in the backend service's secret environment settings. Never commit values or expose them in frontend variables.

- `COINGECKO_API_KEY` — CoinGecko key; sent using the Demo or Pro API header.
- `COINGECKO_API_PLAN` — `demo` (default) or `pro`; selects the matching API host and authentication header.
- `FRED_API_KEY` — FRED observations.
- `SPORTMONKS_API_TOKEN` — Sportmonks Football API.
- `API_FOOTBALL_API_KEY` — API-Football v3.
- `FIRE_SCREENER_API_KEY` — reserve only if/when FireScreener publishes a supported API and authentication method.

DeFiLlama, DexScreener, World Bank, GDELT and Open-Meteo currently use public endpoints without a key in these adapters.

## Evidence and resolution safeguards

- Store source, retrieval timestamp, raw provider response, normalized value, verification status and final resolution record as distinct fields in the market evidence pipeline.
- Preserve original provider response and source hash; do not overwrite it with normalized data.
- Apply provider-specific freshness, rate-limit and response validation before evidence can be considered.
- Where available, corroborate critical facts with an independent provider.
- External providers never decide YES/NO, bypass human-validator consensus or independently trigger settlement.
- FireScreener remains unimplemented until official API documentation and access details are available.

## Deployment boundary

This change does not configure secrets, enable scheduled automation, change contract addresses, submit transactions or deploy services. Contract-specific automation and the Asset Chain indexer must be decoupled from abandoned deployments and prepared for the new contract manifest planned after development.

## Asset Chain full indexer

The backend includes a separate contract-independent Asset Chain indexer for Enugu testnet (chain ID 42421). It reads confirmed blocks through the official RPC and persists:

- Block number, hash, parent hash, timestamp and transaction count.
- Full transaction metadata and transaction receipts.
- Raw contract logs (address, topics, data and log index).
- Native value transfers and standard ERC-20 `Transfer` events, retaining integer token units.
- Wallet first-seen and last-seen block records.
- A durable block cursor and bounded reorg rewind.

This is distinct from the previous manager-event-only statistics indexer and does not require a manager contract address or ABI. It does not decode every custom contract event into business meaning; raw logs are retained so each future contract ABI can be applied after the new contract is deployed.

### Configuration

Keep disabled until the Enugu RPC and intended starting block have been reviewed:

- `ASSET_CHAIN_INDEXER_ENABLED=false`
- `ASSET_CHAIN_INDEXER_START_BLOCK=0` (genesis; set a later known block only when intentionally limiting historical coverage)
- `ASSET_CHAIN_INDEXER_POLL_MS=15000`
- `ASSET_CHAIN_INDEXER_BLOCKS_PER_POLL=3`
- `ASSET_CHAIN_INDEXER_CONFIRMATIONS=3`
- `ASSET_CHAIN_INDEXER_REORG_DEPTH=12`

The first full historical scan can be resource-intensive because each transaction receipt is fetched. Use bounded batches and monitor RPC rate limits and database growth. No on-chain transactions are sent.

### Admin endpoints

These endpoints require the same wallet session and admin authorization as other data-source routes:

- `POST /api/data-sources/asset-chain/indexer/status` — cursor and indexed block/transaction/log/transfer/wallet totals.
- `POST /api/data-sources/asset-chain/wallet` — indexed transactions and transfers for a wallet.
- `POST /api/data-sources/asset-chain/contract-events` — raw logs emitted by a contract.

The SubQuery starter template `asset-chain-testnet-starter` is a separate local-development route. No hosted SubQuery GraphQL endpoint has been verified, so this implementation uses the official RPC directly and leaves hosted SubQuery connectivity for when a real endpoint and schema are supplied.
