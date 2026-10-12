# CoinGecko BTC/ETH/BNB threshold evidence monitor

This optional monitor collects sampled evidence for three proposed markets. It does not create markets, submit wallet transactions, or resolve on-chain outcomes.

## Supported assets and targets

- Bitcoin (CoinGecko ID `bitcoin`): USD price threshold $100,000.
- Ethereum (CoinGecko ID `ethereum`): USD price threshold $4,000.
- BNB (CoinGecko ID `binancecoin`): USD price threshold $1,000.

These are proposal targets, not proof that markets are published. The monitor queries CoinGecko's simple-price endpoint once per minute and stores the provider's source timestamp, the local check time, price, optional market cap, raw response fragment, and SHA-256 evidence hash.

## Enablement

- `COINGECKO_MONITOR_ENABLED=true` enables polling.
- The monitor uses the public CoinGecko endpoint and does not require a secret in this code.
- The backend PostgreSQL database must be configured.
- The read-only latest endpoint is `GET /api/oracles/crypto/latest`.
- The window summary endpoint is `GET /api/oracles/crypto/window?asset=bitcoin&from=<ISO>&to=<ISO>`. Allowed IDs are `bitcoin`, `ethereum`, and `binancecoin`; omit `to` to evaluate through the current time.

## Evidence and limitations

1. Each observation must have a positive price and source timestamp no older than five minutes, with no more than one minute of future clock skew.
2. The monitor records sampled provider observations, not every instantaneous market tick. A brief price spike between samples may not be observed. Market wording must match the chosen provider-snapshot rule.
3. A source outage or stale timestamp produces a monitoring gap. Never infer NO from missing observations.
4. The window endpoint reports a coverage indicator based on the first/last observation and maximum gap. This is a review signal, not a guarantee of perfect coverage and not an automatic settlement decision.
5. WKC market capitalization is deliberately excluded until the project/token identity and CoinGecko asset ID are confirmed. Do not guess the ID.
6. Market settlement still requires authorized review, source evidence, and the existing contract workflow. No automatic market resolution is wired into this monitor.
