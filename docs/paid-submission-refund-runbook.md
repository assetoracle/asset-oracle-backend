# Asset Oracle testnet paid-submission refund runbook

## Scope and safety

This runbook applies only to Asset Chain Enugu Testnet (chain ID 42421), using the approved USDC contract `0xc33741fddEBeA854d265db6F9707900Efb0211a2` with 6 decimals. The refund amount is the original paid amount (currently exactly 10 USDC, or `10000000` atomic units).

The backend does not sign or broadcast treasury transactions. An authorized operator sends the refund from the independently verified treasury wallet, then submits the transaction hash to the backend for on-chain reconciliation. Keep `ASSET_ORACLE_PAID_SUBMISSIONS_TESTNET_ENABLED=false` until all pre-activation checks pass. Never use mainnet funds or keys for this testnet process.

## Operator workflow

1. Confirm the proposal is rejected by an admin and the paid submission is `REJECTED_REFUND_PENDING`.
2. Authenticate with the configured admin wallet and an active backend wallet session.
3. Read the refund queue at `POST /api/markets/paid-submissions/admin/refunds/queue` with JSON body `{"address":"<admin-wallet>" }` and the session bearer token.
4. Independently confirm the configured treasury address, target wallet, token contract, chain ID, and exact atomic amount from the queue. Do not trust a user-supplied recipient or amount.
5. From the treasury wallet UI, send exactly the listed USDC amount to the submitting wallet on Enugu Testnet. Do not send from a personal wallet or a different token contract.
6. Wait for the configured confirmation depth (default 2). Submit the transaction hash to `POST /api/markets/paid-submissions/<submission-id>/verify-refund` with JSON body `{"address":"<admin-wallet>","transactionHash":"0x..." }` and the session bearer token.
7. The backend independently verifies chain ID, successful receipt, treasury transaction sender, USDC contract destination, confirmation depth, and an exact ERC-20 Transfer event from the treasury to the original submitting wallet for the original amount. Only then is the row marked `REFUNDED`.
8. If verification fails, do not mark the refund complete. Investigate and retry with a valid transaction. Keep a separate operational record of the submission ID, tx hash, operator, and time.

## Rehearsal checklist before activation

- [ ] Verify the USDC contract on Enugu Testnet, including live `decimals() == 6`.
- [ ] Independently verify the treasury address and confirm it can send testnet USDC.
- [ ] Successful payment: exact 10 USDC from the authenticated wallet to treasury, correct chain, token, expiry, and confirmation depth; status becomes `PAID_PENDING_REVIEW`.
- [ ] Wrong recipient, wrong amount, wrong token contract, wrong chain, failed receipt, wrong sender, expired quote, and insufficient confirmations are all rejected.
- [ ] Admin approval leaves the submission approved and pending publication; no auto-publishing occurs.
- [ ] Admin rejection transitions to `REJECTED_REFUND_PENDING`; no points are awarded.
- [ ] Refund reconciliation accepts only an exact confirmed treasury-to-original-wallet transfer and is idempotent for the same refund hash.
- [ ] Duplicate payment/refund hashes, cross-wallet quote reuse, replayed quote use, and unauthorized admin requests are rejected.
- [ ] Run the full backend CI suite and review database initialization/migration behavior in a disposable test database.
- [ ] Keep the paid-submission feature flag false until the checklist and operational sign-off are complete.

## Important limitation

The automated test suite uses mocked RPC clients; it does not prove the configured live treasury/token are correct and is not a substitute for the end-to-end Enugu testnet rehearsal. No refund is sent automatically by these endpoints.
