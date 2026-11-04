# Market proposal generator

The generator creates **candidate records only**. It does not create wallet-submitted proposals, approve proposals, publish markets, submit transactions, or settle markets.

## GitHub Actions

The scheduled workflow runs every five minutes but its job is skipped unless the repository variable `MARKET_PROPOSAL_GENERATOR_ENABLED` is exactly `true`. It can also be started manually. The worker independently checks the same environment flag.

Do not enable the repository variable until the database secret and template secret have been reviewed. No secrets or repository variables are configured by this change.

Required GitHub Actions secrets:
- `DATABASE_URL`: backend PostgreSQL connection string.
- `MARKET_GENERATION_TEMPLATES_JSON`: JSON array of approved generation templates.

## Template format

Each template supplies the market wording, provider-specific query, resolution metric and threshold. Dates are generated at runtime from `closeAfterMinutes` and `resolveAfterMinutes`.

```json
[
  {
    "id": "btc-usd-threshold",
    "category": "Crypto",
    "question": "Will Bitcoin trade above 100000 USD?",
    "description": "This candidate resolves using the configured CoinGecko market data at the observation time.",
    "sourceId": "coingecko",
    "metric": "market_data.current_price.usd",
    "comparison": "ABOVE",
    "targetValue": 100000,
    "currency": "USD",
    "query": { "coinId": "bitcoin", "vsCurrency": "usd" },
    "closeAfterMinutes": 60,
    "resolveAfterMinutes": 120
  }
]
```

Supported categories and providers are enforced by the existing market proposal schema:
- Crypto: CoinGecko, DexScreener
- Economics: FRED, World Bank
- Regional: GDELT, Open-Meteo
- RWA: DeFiLlama, DexScreener
- Sports: Sportmonks, API-Football

The category cursor advances in this order: Crypto, Economics, Regional, RWA, Sports. A run processes at most ten configured templates from one category. Missing templates produce no candidate for that category; the rotation still advances.

Candidate proposals are validated by the same Zod schema as user proposals. Duplicate proposal payloads are ignored using a SHA-256 uniqueness key. Candidates are stored in `market_generation_candidates` with `PENDING_REVIEW`; the normal proposal table and its payment/creator workflow are untouched.

The template thresholds and metric paths are configuration, not predictions derived by the generator. A reviewer must check that each template is meaningful and that its source metric is suitable before enabling the workflow. Provider evidence remains separate and must never independently decide a market outcome.
