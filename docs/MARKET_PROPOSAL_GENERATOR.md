# Market proposal generator

The generator creates **candidate records only**. It does not create wallet-submitted proposals, approve proposals, publish markets, submit transactions, or settle markets.

## GitHub Actions

The scheduled workflow runs every ten minutes but its job is skipped unless the repository variable `MARKET_PROPOSAL_GENERATOR_ENABLED` is exactly `true`. It can also be started manually. The worker independently checks the same environment flag.

Do not enable the repository variable until the database secret and template secret have been reviewed. No secrets or repository variables are configured by this change.

Required GitHub Actions secrets:
- `DATABASE_URL`: backend PostgreSQL connection string.
- `MARKET_GENERATION_TEMPLATES_JSON`: JSON array of approved generation templates.

## Template format

Each template supplies the market wording, provider-specific query, resolution metric and threshold. Market closing and resolution timestamps are generated at runtime from `closeAfterMinutes` and `resolveAfterMinutes`. Sports templates can use `dateOffsetDays` (1–30) instead of a fixed `query.date`; the generator calculates the UTC fixture date on each run, interpolates `{{fixtureDate}}` in the question/description, and derives the API-Football season from the fixture date.

```json
[
  {
    "id": "btc-usd-threshold",
    "category": "Digital Assets",
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
- Digital Assets: CoinGecko, DexScreener
- Economics: FRED, World Bank
- Regional: GDELT, Open-Meteo
- RWA: DeFiLlama, DexScreener
- Sports: Sportmonks, API-Football

For Sports templates, use either a fixed `query.date` or `dateOffsetDays`, never both. Prefer `dateOffsetDays` for recurring templates. API-Football templates using this option have their season set automatically according to the football season start year.



Example forward-looking Economics template (FRED):

```json
{
  "id": "us-cpi-year-over-year",
  "category": "Economics",
  "question": "Will the latest published US CPI year-over-year inflation rate exceed 3 percent at resolution?",
  "description": "Resolve using the newest published FRED CPIAUCSL observation transformed to percent change from a year earlier, fetched at resolution.",
  "sourceId": "fred",
  "metric": "observations.0.value",
  "comparison": "ABOVE",
  "targetValue": 3,
  "currency": "PERCENT",
  "query": { "seriesId": "CPIAUCSL", "units": "pc1" },
  "closeAfterMinutes": 43200,
  "resolveAfterMinutes": 44640
}
```

FRED observations are requested newest-first with `sort_order=desc` and `limit=1`, so `observations.0.value` is the latest observation available when evidence is collected. The optional `query.units` transformation supports FRED's documented units, including `pc1` (percent change from a year earlier). The example is a one-month market window; the market wording intentionally refers to the latest published observation at resolution, not a future release date guaranteed by the generator. FRED may not yet have published a new CPI observation by that time, so validators must inspect the observation date and release timing before considering evidence.

For RWA, a DeFiLlama market using `protocol: "ondo-finance"` measures Ondo Finance protocol TVL only. Protocol TVL must not be described as total RWA assets under management or as the value of all Ondo-issued assets.

Example Regional event template:

```json
{
  "id": "nigeria-flood-news",
  "category": "Regional",
  "question": "Will GDELT index at least one Nigeria flood article in the 24-hour evidence window?",
  "description": "Resolve using the number of GDELT articles matching the Nigeria flood search in the rolling 24-hour window before evidence collection.",
  "sourceId": "gdelt",
  "metric": "articles.length",
  "comparison": "ABOVE",
  "targetValue": 0,
  "query": { "search": "\"Nigeria\" flood", "timespan": "24h", "maxRecords": 100 },
  "closeAfterMinutes": 1440,
  "resolveAfterMinutes": 1500
}
```

Example recurring Sports template:

```json
{
  "id": "epl-fixture-date-offset",
  "category": "Sports",
  "sport": "football",
  "question": "Will the English Premier League have a scheduled fixture on {{fixtureDate}}?",
  "description": "Resolve using the API-Football fixture list for {{fixtureDate}}.",
  "sourceId": "api-football",
  "metric": "response.length",
  "comparison": "ABOVE",
  "targetValue": 0,
  "query": { "league": 39 },
  "dateOffsetDays": 7,
  "closeAfterMinutes": 1440,
  "resolveAfterMinutes": 1500
}
```

The currently implemented Sportmonks and API-Football adapters are football feeds. The generator rejects basketball and tennis templates until corresponding provider adapters are implemented.

The category cursor advances in this order: Digital Assets, Economics, Regional, RWA, Sports. A run processes up to ten configured templates from one category. The configuration must contain at least one valid template in every category and no more than ten templates per category; missing or incomplete configuration fails closed before the category cursor advances.

Candidate proposals are validated by the same Zod schema as user proposals. Duplicate candidates are ignored using a SHA-256 identity key built from substantive market fields and the configured relative close/resolve offsets. Runtime observation, closing and resolution timestamps are excluded, so repeated runs of the same market definition do not bypass deduplication. Equivalent candidates are deduplicated even if they use different template IDs. Change the market wording, threshold, provider query or configured schedule when intentionally defining a materially different market. Candidates are stored in `market_generation_candidates` with `PENDING_REVIEW`; the normal proposal table and its payment/creator workflow are untouched.

GDELT templates must configure both `query.search` and `query.timespan` (for example `24h` or `7d`); `query.maxRecords` is optional and bounded to 1–250. The evidence collector requests only articles inside that rolling window, counted through `articles.length`. The window is relative to the time evidence is fetched, not a fixed future calendar interval, so the final evidence collection time must be considered during market review. GDELT article counts establish indexed coverage, not the truth of the reported event.

The template thresholds and metric paths are configuration, not predictions derived by the generator. For FRED, the evidence collector requests the latest observation in descending date order and supports an explicit units transformation such as `pc1`; reviewers must check the returned observation date and whether a new release is expected during the market window. A reviewer must check that each template is meaningful and that its source metric is suitable before enabling the workflow. Provider evidence remains separate and must never independently decide a market outcome.

## Candidate review API

Generated candidates remain separate from wallet-submitted proposals until a configured admin or market creator reviews them. Both endpoints require the reviewer's verified wallet session in the `Authorization: Bearer <session-token>` header and the same wallet address in the JSON body.

- `POST /api/market-candidates/admin/list/session` with `{ "address": "0x...", "limit": 50 }` lists pending candidates (maximum 100).
- `POST /api/market-candidates/admin/:candidateId/decision/session` with `{ "address": "0x...", "decision": "DISMISSED" }` dismisses a candidate.
- The same decision endpoint with `"decision": "PROMOTED"` creates a normal `PENDING_APPROVAL` market proposal and marks the candidate promoted in one database transaction.

Promotion does not approve or publish the market and does not submit an on-chain transaction. The normal proposal approval and publication controls remain separate. Candidate review is rate-limited and repeated decisions are rejected.
