# Aerodrome MCP for Base

**What changed in my Aerodrome positions and rewards?**

A local MCP server for Aerodrome on Base mainnet (chain ID 8453). Compare your current veNFT voting positions and bounded claimable rewards against a saved snapshot, or compare selected pools' voting evidence.

Independent community project. Not affiliated with Aerodrome or Base. This release supports **Aerodrome only**, not every protocol on Base.

Version: **0.1.0**. License: MIT.

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

The demo uses synthetic data, a real local MCP connection and temporary storage. It needs no wallet, network, API key or model. Expect two calls: `BASELINE_CREATED`, then `COMPARED`, with a test reward amount increasing from 100 to 125 raw units.

For live reads:

```sh
cp config.example.json config.json
```

Replace the **synthetic** wallet and token ID in `config.json` with your public wallet address and owned Aerodrome veNFT IDs. Add gauge addresses only if you want LP rewards checked. Never enter a seed phrase or private key. Unknown configuration fields are rejected. Configured veNFT ownership is checked for wallet reward reads.

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
| `aerodrome_wallet_snapshot` | All wallet sections at one block with a final block-hash recheck |
| `aerodrome_compare_pools` | 2–16 distinct pool addresses; voting evidence, not investment ranking |
| `aerodrome_wallet_changes` | New snapshot versus the last complete local baseline |

## Read the result correctly

- `BASELINE_CREATED`: no earlier snapshot exists. It does **not** mean no changes occurred.
- `COMPARED`: changes relative to the last complete baseline. The call updates that baseline; do not repeat it merely to reformat an answer.
- `PARTIAL`: unavailable sections are not compared and the previous complete baseline is retained.
- Missing reward rows mean **unknown**, not zero. A reward decrease does not prove a claim or income.
- Historical vote pools and historical unclaimed rewards are not scanned. Zero current rewards does not prove no historical rewards.
- Raw amounts are authoritative within the RPC evidence. Token labels are untrusted; non-USDC decimals can fall back to 18 for display.
- Voting weight is not APR. Prices, liquidity, volume and profitability are not calculated. Basis-point shares are rounded down; 0 bps can represent a positive share below 0.01%.

## Local data and boundaries

`config.json` and `.snapshot-history/` are local and git-ignored. History retains one complete baseline per configured scope, not every past snapshot. New history directories use 0700, files 0600, with atomic replacement and exclusive locks; files are not encrypted. Corrupt history fails closed. After a crash, inspect the process before manually removing a leftover `.lock`.

`wallet_changes` writes local history (`readOnlyHint=false`); every tool is read-only on chain. No keys, signing, transactions, model calls, schedules or automatic farming. Public RPC endpoints see requested addresses, and the connected MCP client receives configured wallet evidence. Endpoints: `mainnet.base.org`, `mainnet-preconf.base.org`, `base-rpc.publicnode.com`.

RPC trust is required. A block-hash recheck is not a cryptographic proof of correctness or permanent finality. See [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

## Development

`npm test` covers input bounds, partial evidence, block consistency, cancellation, RPC isolation, persistence and real cross-directory stdio startup. `npm run demo` exercises the user scenario through MCP without network calls. Dependencies are locked; install scripts are disabled.

Source and releases: https://github.com/Alubiama/aerodrome-mcp-base . Installation is from source; this is not an npm-published package.
