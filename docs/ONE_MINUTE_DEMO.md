# One-minute demo: what changed in my Aerodrome rewards?

This is an independent, read-only MCP for **Aerodrome on Base**. The walkthrough below uses the public **v0.3.0** release and synthetic data. Once dependencies are installed, the demo needs no wallet connection, signature, API key, model, or RPC read.

## Run it

Requires Node.js 24+ and npm:

```sh
git clone https://github.com/Alubiama/aerodrome-mcp-base.git
cd aerodrome-mcp-base
npm ci --ignore-scripts
npm run demo
```

## What to look for

1. An address-only overview discovers one synthetic veNFT and reports liquid balances, lock state, voting power, and scoped rewards separately.
2. The first history call returns `BASELINE_CREATED`. There is no previous observation, so it makes **no change claim**.
3. The second call returns `COMPARED`. One synthetic gauge reward changes from `100` to `125` raw units, with `deltaRaw: "25"` and the two demo block references.
4. The result says what the evidence supports: the observed amount changed. It does **not** infer a claim, realized income, an APR, or an investment outcome.

The runnable example is [`src/demo.ts`](../src/demo.ts). For live use, a public wallet address can be supplied to the overview; configured snapshots compare only their explicit scope. Missing reward rows mean **unknown**, not zero. The server never signs a transaction.

## Feedback for Aerodrome tooling builders

Would the block-referenced change report and explicit coverage limits be useful in a veAERO holder workflow? If not, which missing data or output format prevents you from using it? A concrete failure case is more useful than a general endorsement.

This project is not affiliated with Aerodrome or Dromos Labs. The demo is synthetic and does not demonstrate a real user's returns.
