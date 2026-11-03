# Asset Oracle market data providers

Backend-only provider adapters and admin-authenticated read endpoints. This integration does not change Solidity contracts, fee constants, token configuration, validator roster, or settlement rules.

## Provider coverage

| Market category | Provider | Access configured by |
|---|---|---|
| Digital Assets | CoinGecko | `COINGECKO_API_KEY` |
| Digital Assets | DexScreener | Public API |
| Real-World Assets | DeFiLlama | Public/free endpoints only; no Pro RWA endpoints |
| Real-World Assets | DexScreener | Public API; shared adapter |
| Economic & Financial | FRED | `FRED_API_KEY` |
| Economic & Financial | World Bank | Public API |
| Regional & Global Events | GDELT | Public API |
| Regional & Global Events | Open-Meteo | Public API, subject to the usage/licensing arrangement selected by the project |
| Sports | Sportmonks | `SPORTMONKS_API_TOKEN` |
| Sports | API-Football | `API_FOOTBALL_KEY` |

FireScreener and the Asset Chain Indexer are intentionally not implemented yet: their API source/endpoint details are still awaited. Add their adapters when the user supplies the official integration details. Do not scrape FireScreener or guess indexer endpoints.

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

These routes are admin-only provider access endpoints. They do not yet constitute an automated market-generation pipeline. External APIs must not independently select YES/NO outcomes, bypass human-validator consensus, or authorize settlement.

## Outstanding integrations

- FireScreener: awaiting official API documentation/source and access method from the user.
- Asset Chain Indexer: awaiting official endpoint/documentation and authentication details from the user.

## Mainnet safety

- The lifecycle worker currently targets Asset Chain Enugu testnet (chain ID 42421) only.
- Asset Chain mainnet uses chain ID 42420 and `https://mainnet-rpc.assetchain.org`; this does not establish that the current manager address is deployed on mainnet.
- Do not enable the worker on mainnet until a verified manager address, token address/decimals, validator roster, role grant, treasury/reward recipients and deployment evidence are confirmed.
- Existing contract economics remain unchanged: 0.25% trading fee and 2% settlement fee on eligible winning settlements.
