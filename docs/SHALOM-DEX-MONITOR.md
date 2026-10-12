# SHALOM Asset Chain DEX monitor

This monitor collects evidence only. It does not submit blockchain transactions or settle markets.

## Pricing method

- Asset Chain mainnet only (chain ID 42420).
- SHALOM/USD is derived from a 5-minute Uniswap-V3-style time-weighted average tick for SHALOM/xRWA multiplied by the xRWA/USDT TWAP.
- The USDT/USD conversion is fetched from CoinGecko's Tether reference endpoint. The response must include a valid timestamp no older than five minutes.
- A snapshot is recorded every 60 seconds in PostgreSQL, with pool addresses, TWAP ticks, block number, both pool liquidity values, the USDT/USD response, and a SHA-256 evidence hash.
- The read-only endpoint is GET /api/oracles/shalom/latest. It reports recent observations only; it must not be treated as proof of uninterrupted coverage over an entire market window.
- A threshold crossing is evidence for validator review, not an automatic on-chain YES outcome. Missing/stale observations must never be interpreted as NO.

## Required backend environment

Set these only after verifying the token addresses and live pool parameters on Asset Chain mainnet:

- SHALOM_DEX_MONITOR_ENABLED=true to enable background polling.
- ASSET_CHAIN_MAINNET_RPC_URL=https://mainnet-rpc.assetchain.org (default).
- SHALOM_TOKEN_ADDRESS=0xf20f989CAf263C513f9183B4Fed88F14Fc04c8dB (defaults to the address supplied by the project owner).
- ASSET_CHAIN_XRWA_TOKEN_ADDRESS — verified xRWA token address on Asset Chain mainnet.
- ASSET_CHAIN_USDT_TOKEN_ADDRESS — verified bridged USDT token address on Asset Chain mainnet.
- SHALOM_XRWA_POOL_FEE=10000 and XRWA_USDT_POOL_FEE=3000 — initial fee tiers based on the public pool listing; the factory must resolve these to the expected token pairs before data is accepted.
- SHALOM_XRWA_MIN_LIQUIDITY and XRWA_USDT_MIN_LIQUIDITY — positive raw on-chain liquidity thresholds selected after checking current pool state. The code deliberately does not guess these values.

The factory defaults to the official Asset Chain Swap mainnet deployment at 0xa9d53862d01190e78ddaf924a8f497b4f8bb5163. Override it only after verifying an official deployment.

## Operational caveats

1. Configure the correct token addresses and minimum liquidity values before enabling the monitor. It fails closed on missing configuration, wrong chain, token-symbol mismatch, missing pool, low liquidity, stale USDT/USD data, or insufficient TWAP history.
2. A process restart or service outage creates a monitoring gap. Review observation timestamps and service logs; do not resolve NO unless complete, sufficient coverage exists for the full market window.
3. A 5-minute TWAP is intentionally harder to manipulate than a single spot quote, but it may not record a brief price spike. Market wording must explicitly define the threshold as a qualifying 5-minute TWAP at or above $1.00, rather than an instantaneous spot wick.
4. Pool liquidity and manipulation safeguards require review before publication. The monitor checks configured raw active liquidity; it does not itself enforce a USD TVL minimum.
5. CoinGecko rate limits or outages can interrupt observations. Failures are logged and do not create NO evidence.
6. Evidence is stored in the backend PostgreSQL database; this is not an immutable public archive. For production settlement, export evidence to durable storage and retain audit access.
