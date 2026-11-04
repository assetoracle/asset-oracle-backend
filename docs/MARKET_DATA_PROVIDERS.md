# Asset Oracle market data providers

Backend-only provider clients and admin-authenticated routes. Provider credentials are read from backend environment variables and are never sent to the browser. These integrations collect source evidence; they do not select market outcomes or authorize settlement.

## Approved provider coverage

| Segment | Provider | Status / purpose |
|---|---|---|
| Digital assets | CoinGecko | Implemented; market listings and market-cap data |
| Digital assets | FireScreener | Pending provider API availability; no scraping or guessed endpoints |
| RWA | DeFiLlama | Implemented; protocol TVL and DEX overview |
| RWA | DexScreener | Implemented; token pair and liquidity discovery |

| Economic & financial | FRED | Implemented; series observations |
| Economic & financial | World Bank | Implemented; country indicator observations |
| Regional & global events | GDELT | Implemented; article discovery |
| Regional & global events | Open-Meteo | Implemented; historical weather observations |
| Sports | Sportmonks | Implemented; fixtures by date |
| Sports | API-Football | Implemented; fixtures by date, optional league and season |

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
