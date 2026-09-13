# Aerodrome MCP for Base

**What changed in my Aerodrome positions and rewards?**

A local MCP server for Aerodrome on Base mainnet (chain ID 8453). Compare your current veNFT voting positions and bounded claimable rewards against a saved snapshot, or compare selected pools' voting evidence.

Independent community project. Not affiliated with Aerodrome or Base. This release supports **Aerodrome only**, not every protocol on Base.

Version: **0.2.1**. License: MIT.

## Quick start

Requires Node.js 24 or newer and npm.

```sh
git clone https://github.com/Alubiama/aerodrome-mcp-base.git
cd aerodrome-mcp-base
```

From your local repository checkout:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run demo
```

The demo uses synthetic data, a real local MCP connection and temporary storage. It needs no wallet, network, API key or model. It shows an address-only overview followed by `BASELINE_CREATED` and `COMPARED`, with a test reward amount increasing from 100 to 125 raw units.

To set optional local wallet defaults:

```sh
cp config.example.json config.json
```

Local configuration is optional for public protocol/pool reads and for `wallet_overview` with an explicit wallet address. If using `config.json`, replace its **synthetic** wallet with your public address. `veNftTokenIds` may be empty; the overview discovers owned IDs automatically. Configured snapshot/change tools continue to use the explicitly configured IDs. Add gauge addresses only if you want LP rewards checked. Never enter a seed phrase or private key. Unknown configuration fields are rejected. Configured veNFT ownership is checked for wallet reward reads.

## Connect an MCP client

Use absolute paths for your checkout and Node executable:

```json
{
  "mcpServers": {
    "aerodrome": {
      "command": "/absolute/path/to/node",
      "args": [
        "--import", "/absolute/path/to/aerodrome-mcp-base/node_modules/tsx/dist/loader.mjs",
        "/absolute/path/to/aerodrome-mcp-base/src/mcp/index.ts"
      ]
    }
  }
}
```

Use a client tool timeout of **150 seconds**. The server deadline is 120 seconds; concurrency is capped at two active reads. Paths are resolved relative to the checkout, so launching from another directory works. Run Node directly for stdio; do not put npm banners on the protocol stream.

For Codex, add the equivalent `[mcp_servers.aerodrome]` table to project `.codex/config.toml` in a trusted project, with `command`, `args`, `startup_timeout_sec = 20` and `tool_timeout_sec = 150`.

## Ask your assistant

- “What changed in my wallet since the last check?”
- “Show my current Aerodrome voting positions and bounded rewards.”
- “Compare the voting weights and gauge status of these pool addresses: …”

| Tool | Purpose |
| --- | --- |
| `aerodrome_protocol_status` | Official contract identity, block, epoch and protocol weights |
| `aerodrome_voting_position` | Configured or supplied veNFT voting positions |
| `aerodrome_wallet_rewards` | Current-vote reward scope and explicitly configured LP gauges |
| `aerodrome_wallet_overview` | Address-first balances, automatic veNFT discovery, locks, voting, rewards and an English brief |
| `aerodrome_wallet_snapshot` | All wallet sections at one block with a final block-hash recheck |
| `aerodrome_compare_pools` | 2–16 distinct pool addresses; voting evidence, not investment ranking |
| `aerodrome_wallet_changes` | Capture with a UUID `requestId`; retry the same ID to recover the same report |
| `aerodrome_wallet_report` | Retrieve a saved report by `reportId`, without RPC or baseline changes |

## One-address overview

```json
{"name":"aerodrome_wallet_overview","arguments":{"wallet":"0x0000000000000000000000000000000000000002"}}
```

Use your own public address instead of the synthetic example. No manual veNFT IDs or local config are required. The result separates:

- Liquid ETH, the escrow's underlying token (AERO), configured USDC and up to 16 extra `tokens` supplied by address. This is a bounded token list, not all assets in a wallet.
- Up to 16 directly owned veNFTs from the official escrow owner list, with verified ownership, normal locked principal and unlock time.
- Current voting power and epoch state. The normal voting window alone does not establish transaction eligibility or success.
- Current-vote rewards and up to 16 explicitly supplied `gauges`. Configured gauges are inherited only for the same configured wallet. LP principal valuation, historical rewards, rebases and managed rewards are not included.

`summary` gives an English brief; structured values retain addresses, source links, raw amounts and the common observed block. Missing values are null. Failed sections leave independently verified sections available; a changed block hash rejects the whole observation. Managed positions have `UNSUPPORTED_MANAGED` and null personal principal: pooled balances must not be attributed to the wallet owner. No aggregate net worth is calculated.

`decimalsSource` distinguishes on-chain/canonical units from assumed or unknown units. New reward reads set `amountFormatted=null` if decimals are assumed; the raw amount remains available. Token labels are untrusted display data.

The overview is a fresh read and does not update local history. `wallet_changes` still compares configured veNFT/current-reward scope; it does not yet track liquid-balance or lock-principal history. New reports include `findings`: English explanations with codes, block interval and source links. They describe observations, not inferred deposits, sales or claimed income. Old reports remain retrievable and may have no findings or unit provenance.

Protocol basis: the official [VotingEscrow implementation](https://github.com/aerodrome-finance/contracts/blob/main/contracts/VotingEscrow.sol) and [interface](https://github.com/aerodrome-finance/contracts/blob/main/contracts/interfaces/IVotingEscrow.sol) define owner enumeration, lock tuples and managed escrow types. Runtime reads are pinned to a single Base block and rechecked; these source references are not a substitute for RPC verification.

### Upgrading from 0.2.0

Use `summary` instead of `summaryRu`, and `findings[].message` instead of `findings[].messageRu`. All generated prose is English. Historical report findings are rendered in English from their stored structured evidence; report IDs, observations and raw changes remain unchanged. Retrieval does not rewrite the stored file or make RPC calls.

## Read the result correctly

- `BASELINE_CREATED`: no earlier snapshot exists. It does **not** mean no changes occurred.
- `COMPARED`: changes relative to the last complete baseline. A new request ID updates that baseline. Reusing the same request ID returns the original report, including its original block interval.
- `PARTIAL`: the report is saved, unavailable sections are not compared, and the previous complete baseline is retained.
- When a configured veNFT has another owner, `excludedTokenIds` records its ID and observed owner. Other owned veNFT and configured gauge rewards are still returned. Rewards are marked partial; the voting section can still show the ownership change. A failed ownership RPC still fails the read; it is not evidence of a transfer.
- Missing reward rows mean **unknown**, not zero. A reward decrease does not prove a claim or income.
- Historical vote pools and historical unclaimed rewards are not scanned. Zero current rewards does not prove no historical rewards.
- Raw amounts are authoritative within the RPC evidence. Token labels are untrusted; unverified decimals are identified and new reads leave their formatted amount null. Legacy reports may contain an older display fallback; retain raw amounts and provenance.
- Voting weight is not APR. Prices, liquidity, volume and profitability are not calculated. Basis-point shares are rounded down; 0 bps can represent a positive share below 0.01%.

## Capture, retry and read again (0.1.1)

**Upgrade:** stop older server processes before switching versions; mixed-version writers do not share the new canonical lock. `aerodrome_wallet_changes` now requires a client-generated UUID `requestId`. Generate it **before** sending the call and retain it until the response is received. Old calls with `{}` are rejected before any RPC or baseline update.

```json
{"name":"aerodrome_wallet_changes","arguments":{"requestId":"a8098c1a-f86e-4b13-9ac8-83efbafec0d1"}}
```

If the response is lost, repeat that exact call. It returns the same saved report and never consumes the comparison twice. To read it later, including after server restart:

```json
{"name":"aerodrome_wallet_report","arguments":{"reportId":"a8098c1a-f86e-4b13-9ac8-83efbafec0d1"}}
```

The example UUID is illustrative: use a fresh UUID only when deliberately requesting a **new** comparison. `reportId` equals the original `requestId`. `reportSaved` confirms the atomic commit; `baselineSaved` describes that original capture, not an update during replay. IDs are scoped to the configured wallet, veNFTs, gauges and contracts. Changing actual scope selects a different history; changing `1` to `01`, address case, or gauge ordering does not.

Two processes share an exclusive scope lock acquired before RPC. A competing capture gets `HISTORY_BUSY`; retry with the **same** ID after the writer finishes. Already committed reports remain readable while a writer holds the lock. After an interrupted uncommitted capture, verify that its process has stopped before removing its leftover lock, then retry the same ID. RPC failure or cancellation before commit leaves the baseline and reports unchanged.

## Local data and boundaries

`config.json` and `.snapshot-history/` are local and git-ignored. History retains one complete baseline plus immutable change reports per configured scope, not every past snapshot. Report and baseline are stored together in one atomic replacement. Each scope is limited to 100 reports and 32 MB: `HISTORY_FULL` refuses new captures rather than evicting retry IDs. Existing reports remain readable. Archive the history locally before explicitly starting a new history; old IDs require the archived history and original scope. New history directories use 0700, files 0600, with atomic replacement and exclusive locks; files are not encrypted. Atomic replacement protects against process interruption; power-loss durability and network filesystems are not guaranteed. Corrupt history fails closed. Version 1 baselines are imported on the next successful capture; equivalent noncanonical files are retained. If several equivalent legacy baselines exist, capture stops for manual reconciliation rather than choosing one silently. After a crash, inspect the process before manually removing a leftover `.lock`.

`wallet_changes` writes local history (`readOnlyHint=false`); every tool is read-only on chain. No keys, signing, transactions, model calls, schedules or automatic farming. Public RPC endpoints see requested addresses, and the connected MCP client receives configured wallet evidence. Endpoints: `mainnet.base.org`, `mainnet-preconf.base.org`, `base-rpc.publicnode.com`.

RPC trust is required. A block-hash recheck is not a cryptographic proof of correctness or permanent finality. See [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

## Development

`npm test` covers input bounds, partial evidence, block consistency, cancellation, RPC isolation, persistence and real cross-directory stdio startup. `npm run demo` exercises the user scenario through MCP without network calls. Dependencies are locked; install scripts are disabled.

Source and releases: https://github.com/Alubiama/aerodrome-mcp-base . Installation is from source; this is not an npm-published package.
