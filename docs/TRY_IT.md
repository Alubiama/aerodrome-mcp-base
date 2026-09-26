# Try one job: explain a reward change

**For:** developers building Aerodrome dashboards or MCP clients.  
**Result:** a structured change report you can inspect before building any UI.  
**Fixture:** synthetic data, not a live wallet, claimed income or investment outcome.

## Run the published source

Requires Node.js 24+ and npm. Dependency installation uses the network; the demo itself is offline.

```sh
git clone https://github.com/Alubiama/aerodrome-mcp-base.git
cd aerodrome-mcp-base
npm ci --ignore-scripts
npm run demo
```

The demo runs a real local MCP connection with synthetic inputs and temporary history storage. It needs no wallet connection, signature, model, API key or RPC call.

## Check these results

1. The address-only overview discovers one synthetic veNFT and separates balances, locks, voting power and scoped rewards.
2. `BASELINE_CREATED` contains no changes: there is no earlier observation to compare.
3. `COMPARED` contains a reward row with `before: "100"`, `after: "125"`, `deltaRaw: "25"`. Its finding identifies blocks `100` and `101`.
4. The finding explicitly leaves the cause and realized income unestablished. A change in observed claimable rewards is not proof of a claim or earnings.

These are raw fixture units, not dollars, APR or live AERO rewards. See the [captured output](DEMO_OUTPUT.json) and [runnable source](../src/demo.ts).

## Try the partial-data UI

```sh
npm run demo:integration:build
python3 -m http.server 8766 --bind 127.0.0.1 --directory integration-demo
```

Open `http://127.0.0.1:8766`. Move the split, then select **Missing reward entry**. Check that the panel displays incomplete coverage and known-entry subtotals, rather than presenting missing data as zero. The panel uses saved synthetic responses generated through local MCP stdio; it is not a live dashboard. Competing-vote stress cases are hypotheses with fixed deposits, not forecasts.

## Tell us where it fails

[Open an issue](https://github.com/Alubiama/aerodrome-mcp-base/issues/new) with:

- Node version, operating system, release/commit and the command that failed.
- Expected versus actual result, with a small synthetic reproduction.
- The existing task this would help with, or why your current tool is already sufficient.

Do not include private configuration, wallet history, credentials or decision cards. Redact local paths and identifiers from shared output.

A useful evaluation is an independent successful run followed by one concrete use case or blocker. A positive comment alone is not an integration. For a bounded test integration, see [PILOT.md](../PILOT.md).

Independent community project; not affiliated with Aerodrome, Base or Dromos Labs. No signing or transaction execution.
