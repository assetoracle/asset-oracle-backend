# Asset Oracle market data providers

This module adds backend-only data-provider clients and admin-authenticated endpoints. It does not modify the Solidity contract, fee constants, token configuration, validator roster, or settlement rules.

## Available endpoints

All routes require a valid wallet session in the `Authorization: Bearer <session-token>` header. The request body must also include the authenticated admin wallet's `address`.

| Method and path | Required body fields | Purpose |
|---|---|---|
| POST `/api/data-sources/dexscreener/search` | `address`, `query` | Search DEX trading pairs |
| POST `/api/data-sources/dexscreener/token-pairs` | `address`, `chain`, `tokenAddress` | Read pools for an exact token contract |
| POST `/api/data-sources/defillama/protocols` | `address` | List supported protocols and TVL |
| POST `/api/data-sources/defillama/tvl` | `address`, `protocol` | Read protocol TVL |
| POST `/api/data-sources/sports/matches` | `address`, `competition`, optional `dateFrom`, `dateTo` | Read fixtures and match results |
| POST `/api/data-sources/economics/fred` | `address`, `seriesId`, optional `start`, `end` | Read economic observations |
| POST `/api/data-sources/regional/gdelt` | `address`, `query`, optional `maxRecords` | Discover news reports for regional events |

Provider responses include provider name, retrieval time, source reference, and a SHA-256 hash of the returned response body. These are evidence metadata, not proof that a source is correct. The API-key query parameter used by FRED is redacted from the returned source reference.

## Required secrets

Configure these in the backend service's secret environment settings, never in frontend code or Git:

- `FOOTBALL_DATA_API_KEY` — needed for football-data.org match requests.
- `FRED_API_KEY` — needed for FRED economic observations.

DexScreener, DeFiLlama, and GDELT use their documented public endpoints in this implementation. Observe provider rate limits and plan restrictions.

## Mainnet safety

- The lifecycle worker currently targets Asset Chain Enugu testnet (chain ID 42421) only.
- Asset Chain mainnet uses chain ID 42420 and `https://mainnet-rpc.assetchain.org`; this does not establish that the current manager address is deployed on mainnet.
- Do not enable the worker on mainnet until a verified mainnet manager address, token address/decimals, validator roster, role grant, treasury/reward recipients, and deployment evidence are confirmed.
- FireScreener's current documentation does not provide a public third-party API. Do not scrape its website or invent endpoints.
- IMF Data and Africa API are not included in this initial adapter set; verify the specific dataset/API and credentials before adding them.
- External APIs must not select outcomes, bypass human-validator consensus, or independently authorize settlement. Settlement continues to follow the existing contract.
- Existing contract economics remain unchanged: 0.25% trading fee and 2% settlement fee on eligible winning settlements. Do not edit these constants as part of this integration.
