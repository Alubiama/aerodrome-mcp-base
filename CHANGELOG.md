# Changelog

## 0.4.0 — 2026-09-14

- Added `aerodrome_wallet_accounting`: bounded block pagination, receipt/transfer-verified escrow deposits and withdrawals, explicit voting-pool rewards and selected veNFT rebases. Per-token page sums link to contributing events; end-block holdings remain independent. Failed pages require retry; missing scope is not zero. Rebase totals require matching historical wallet ownership before/after the event block and no intra-block NFT transfers; foreign or ambiguous ownership is excluded. No lifetime discovery, LP P&L, automatic trades, or invented USD profit.

## 0.3.0 — 2026-09-14

- Added absolute configuration/history path overrides for isolated SSH-hosted accounts and a compiled build command. The local stdio defaults are preserved.

- Added `aerodrome_reward_plan` and read-only reward token cards for `USDC`, `HOLD_SELECTED` and `MIXED` scenarios. Retention inputs are explicit; direct classic USDC quotes, indexer market observations and dated research claims remain bounded and independent. Missing research, sellability, final rewards and net proceeds remain unknown. No trade, approval, signing or automatic token selection is performed.

- Deduplicated identical pinned contract reads within each configured snapshot, including in-flight requests. Failed reads are retriable; cancellation, ownership checks, fresh subsequent snapshots and final block-hash verification are preserved. Public RPC delays can still exceed the request deadline.
- Extended coherent snapshots and local history with bounded liquid balances and configured lock principal/ownership/permanence. Legacy snapshots initialize new sections without inferred changes. Partial sections retain the last complete baseline; v3 storage keeps v1/v2 reports readable.

- Added bounded pool registration discovery with cursor pagination, token pairs and gauge status. Registration order is not a token listing date.
- Added current-epoch bribe and fee deposits with conditional voting scenarios: evidence-only, new marginal votes, or explicit normal-veNFT full allocation. Raw units, partial coverage and sources are retained; no USD or APR ranking is implied.
- Source release for local stdio use and private SSH hosting; no automatic trading or npm publication.

## 0.2.1 — 2026-09-13

- Switched generated summaries, change explanations and client instructions to English.
- Renamed response fields to `summary` and `findings[].message`; updated demo, tests and documentation.
- Existing 0.2.0 reports remain readable: English descriptions are rendered from stored evidence without changing report IDs, raw changes or observations, and without RPC or a write during retrieval.

Client migration: replace `summaryRu` and `findings[].messageRu` with the new English field names.

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
