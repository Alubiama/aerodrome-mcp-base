# Changelog

## 0.2.0 — 2026-09-13

- Added `aerodrome_wallet_overview`: a public address is sufficient for bounded liquid balances, discovered owned veNFTs, normal locked principal, voting state, current rewards and a Russian brief at one rechecked Base block.
- Public protocol/pool reads work without wallet configuration; configured veNFT IDs are optional. Missing wallet input gives an actionable `WALLET_REQUIRED` error.
- Added deterministic Russian findings to new change reports, with block intervals, source links and unit provenance. Historical reports remain readable.
- Unknown token decimals no longer produce a formatted reward amount. Consumers must accept `amountFormatted=null` and inspect `decimalsSource`.
- Partial reads preserve independently verified sections; managed principal remains explicitly unknown. Balances, locks, voting power and rewards are never summed into a wallet value.

Coverage remains bounded: 16 owned NFTs, default token balances plus at most 16 extra tokens, and 16 explicit LP gauges. No historical reward scan, net-worth/APR calculation, LP principal valuation or autonomous transactions. Overview reads do not change the configured change-report baseline.

## 0.1.1 — 2026-09-13

- Required caller-generated `requestId` for wallet captures; the same ID replays the immutable report without RPC. Calls with `{}` must be updated.
- Added `aerodrome_wallet_report` for retrieval after lost responses or restart. Report and baseline commit together; partial reports are retained without replacing the complete baseline.
- Canonical token IDs, address case, contract key order and duplicate gauge normalization; import of unambiguous v1 baselines.
- Transferred veNFTs are explicitly excluded from wallet rewards with partial status. Other owned positions and gauges remain available; voting evidence retains the observed owner.
- Regression coverage for lost replies, fresh processes, competing writers, killed writers, cancelled and failed commits, retention limits and legacy history.

History is bounded to 100 reports / 32 MB per scope, without silent eviction. A crashed writer may require verified local lock recovery. No live wallet or transaction execution is part of these tests.

## 0.1.0 — 2026-09-13

- Six Aerodrome tools for Base mainnet.
- Coherent wallet snapshots and selected pool comparisons with strict output schemas.
- Exact local wallet deltas, partial-section handling and atomic baseline persistence.
- Minimal public-address configuration, read-only ABIs, bounded RPC and cancellation.
- Synthetic offline MCP demo and regression suite.

Initial source release. Installation, regression tests and synthetic demo verified from a clean local copy.
