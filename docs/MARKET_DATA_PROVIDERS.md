# Asset Oracle market data providers

Backend-only provider adapters and admin-authenticated read endpoints. Provider capabilities are reusable across market categories; a provider is not restricted to one category. This integration does not change Solidity contracts, fee constants, token configuration, validator roster, or settlement rules.

## Cross-category provider capability map

| Provider | Digital Assets | RWA | Economic & Financial | Regional & Global Events | Sports |
|---|---|---|---|---|---|
| CoinGecko | Primary: token prices, market data and historical charts | Supporting: tokenized-asset/token market data where listed | — | — | — |
| DexScreener | Primary: token pairs, liquidity and trading activity | Supporting: tokenized-asset pools and market activity where listed | — | — | — |
| DeFiLlama | Supporting: protocols, TVL, DEX volumes and ecosystem metrics | Supporting: protocol/chain TVL and RWA-adjacent DeFi metrics available on free endpoints | — | — | — |
| FireScreener | Intended: screener data once official API is supplied | Intended: screener data once official API is supplied | — | — | — |
| Asset Chain Indexer | Supporting: Asset Oracle market-contract events and indexed transactions | Supporting: Asset Oracle market-contract events; not a general RWA contract index | — | — | — |
| FRED | — | — | Primary: US economic and financial series | — | — |
| World Bank | — | — | Primary: country and development indicators | Supporting: country-level context where relevant | — |
| GDELT | — | — | Supporting: news evidence for relevant economic events | Primary: global news and event discovery | Supporting: sports-related news only when relevant |
| Open-Meteo | — | — | Supporting: weather-linked economic/RWA events | Primary: weather and forecast evidence | Supporting: weather conditions affecting scheduled sports events |
| Sportmonks | — | — | — | Supporting: sports-related event reporting where relevant | Primary: fixtures, scores and match data |
| API-Football | — | — | — | Supporting: sports-related event reporting where relevant | Primary: fixtures, scores and match data |

**Important:** “Supporting” does not mean every endpoint is suitable for every market. Market templates must choose the specific fields, endpoint, freshness window and source-quality rules needed for each question. CoinGecko, DexScreener and DeFiLlama may all contribute to both Digital Asset and RWA markets. FireScreener will be mapped across both once its official API is supplied. The Asset Chain Indexer can provide evidence for both on-chain digital assets and RWAs.

## Implementation status

- Available adapters: CoinGecko, DexScreener, DeFiLlama, FRED, World Bank, GDELT, Open-Meteo, Sportmonks and API-Football.
- FireScreener remains pending official API documentation/access from its team.
- Existing internal Asset Oracle on-chain stats indexer is available for Asset Oracle market-manager events (Staked, MarketFinalized, Claimed and Refunded). Reuse it as a limited on-chain evidence source; it is not a general Asset Chain indexer and does not currently index arbitrary RWA contracts, token transfers or all chain activity.
- Do not scrape FireScreener or guess Asset Chain Indexer endpoints.
- The DeFiLlama integration uses public/free endpoints only; do not call paid Pro-only RWA endpoints.

## Endpoints

All routes require a valid wallet session in `Authorization: Bearer <session-token>` and the admin wallet's `address` in the JSON body.

| Method and path | Additional body fields | Purpose |
|---|---|---|
| POST `/api/data-sources/coingecko/coin` | `coinId`, optional `vsCurrency`, `days` | Coin market chart |
| POST `/api/data-sources/dexscreener/search` | `query` | Search DEX pairs |
| POST `/api/data-sources/dexscreener/token-pairs` | `chain`, `tokenAddress` | Pools for exact token |
| POST `/api/data-sources/defillama/protocols` | — | Protocol catalogue |
| POST `/api/data-sources/defillama/tvl` | `protocol` | Protocol TVL |
| POST `/api/data-sources/defillama/chain-tvl` | `chain` | Historical chain TVL |
| POST `/api/data-sources/sports/sportmonks/fixtures` | `date` | Fixtures for a date |
| POST `/api/data-sources/sports/api-football/fixtures` | `date`, optional `league`, `season` | Fixtures for a date/league |
| POST `/api/data-sources/economics/fred` | `seriesId`, optional `start`, `end` | FRED observations |
| POST `/api/data-sources/economics/world-bank` | `country`, `indicator`, optional `page` | World Bank indicator series |
| POST `/api/data-sources/regional/gdelt` | `query`, optional `maxRecords` | Regional/global news discovery |
| POST `/api/data-sources/regional/open-meteo` | `latitude`, `longitude`, optional `forecastDays` | Weather forecast data |

## Required environment secrets

Set these in the backend's secure environment settings. Never put credentials in frontend code or commit them to Git:

- `COINGECKO_API_KEY`
- `FRED_API_KEY`
- `SPORTMONKS_API_TOKEN`
- `API_FOOTBALL_KEY`

DexScreener, DeFiLlama free endpoints, World Bank, GDELT and Open-Meteo use public endpoints in this adapter. Respect each provider's rate limits, terms, attribution requirements and commercial-use conditions. The Open-Meteo endpoint being public does not itself establish the project's licence entitlement.

## Evidence and security

Each provider response includes provider name, source reference, retrieval timestamp and SHA-256 hash of the response body. These are provenance metadata, not proof that the source is accurate. API credentials are sent in headers or query parameters as required by each provider and are redacted from the returned source reference.

These routes are admin-only provider access endpoints. They do not yet constitute an automated market-generation pipeline. External APIs must not select outcomes, bypass human-validator consensus, or independently authorize settlement.

## Mainnet safety

- The lifecycle worker currently targets Asset Chain Enugu testnet (chain ID 42421) only.
- Asset Chain mainnet uses chain ID 42420 and `https://mainnet-rpc.assetchain.org`; this does not establish that the current manager address is deployed on mainnet.
- Do not enable the worker on mainnet until a verified manager address, token address/decimals, validator roster, role grant, treasury/reward recipients and deployment evidence are confirmed.
- Existing contract economics remain unchanged: 0.25% trading fee and 2% settlement fee on eligible winning settlements.

## Staggered category rotation

The branch now includes a deterministic rotation selector in `src/services/marketDataRotation.ts`:

1. Real-World Assets
2. Digital Assets / Spot
3. Economic & Financial Data
4. Regional & Global Events
5. Sports
6. Repeat

Each slot is 10 minutes. A category therefore gets a turn every 50 minutes. The slot is calculated from the absolute UTC 10-minute interval, so the same instant always resolves to the same category after a worker restart; it does not depend on an in-memory counter or a mutable schedule row.

The selector also filters candidate providers against the adapters currently configured. FireScreener remains omitted until its official API details are supplied. The existing Asset Oracle on-chain stats indexer is listed as a limited internal evidence source, subject to its enablement and indexing status.

**Current boundary:** this commit establishes and tests the rotation schedule only. It does not yet fetch data or generate markets. A market-generation layer still needs approved market templates and their exact data requirements (for example, the asset/token, country and indicator, event query, location, or competition). Once those inputs exist, the active slot can invoke only the relevant provider adapters, with caching and source fallback. No API is called merely because its category's slot is active.

## Existing Asset Oracle on-chain stats indexer

The repository already contains `src/services/onchainStatsIndexer.ts`. It reads confirmed logs from the configured Asset Oracle market manager on Asset Chain Enugu testnet (chain ID 42421), stores them in PostgreSQL, and tracks indexed block cursors. Its supported event types are `Staked`, `MarketFinalized`, `Claimed` and `Refunded`.

The server starts it only when `ONCHAIN_STATS_INDEXER_ENABLED=true`; the example environment keeps it disabled by default. Before enabling it, verify the current manager deployment and the configured indexer start block. The indexer currently uses the existing Enugu RPC endpoint and a default start block of 4,502,688.

**Scope limitation:** this is an Asset Oracle contract-event indexer, not a chain-wide Asset Chain explorer/indexer. It does not currently index arbitrary RWA contracts, all ERC-20 transfers, or all transactions on Asset Chain. We can use its existing indexed Asset Oracle market events as on-chain evidence now; broader RWA coverage would require extending it with the relevant contract addresses and event ABIs or using a separate chain-wide indexer.
