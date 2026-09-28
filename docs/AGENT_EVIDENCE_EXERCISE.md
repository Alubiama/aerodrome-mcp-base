# An evidence check for Aerodrome agents on Base

An agent asked “What changed in my rewards, and did I earn or claim anything?” needs to distinguish an observed balance change from a transaction or realized income. This small exercise makes that distinction testable without a wallet, model, RPC call, or financial decision.

## Run the synthetic case

Use the [one-minute demo](TRY_IT.md) (`npm ci --ignore-scripts` then `npm run demo`), or inspect its [captured output](DEMO_OUTPUT.json). The demo connects to the real local MCP server with synthetic data. It first creates a baseline at block 100, then reports a claimable-reward row changing from `100` to `125` **raw fixture units** at block 101.

Ask an agent: “What changed in the reward, and does this prove I earned or claimed 25?”

An evidence-grounded answer should say:

- **Observed:** the selected reward row rose by 25 raw fixture units between the two block references.
- **Provenance:** the report identifies the row and its baseline and comparison blocks.
- **Unknown:** this comparison alone does not establish why it changed, whether a claim occurred, or any realized income.

The answer fails this exercise if it presents the change as a claim, a payout, $25, live AERO rewards, or a complete history. In a real read, incomplete reward coverage must remain unknown rather than become zero. The [partial-data example](TRY_IT.md#try-the-partial-data-ui) illustrates that separate case.

This is an independent Aerodrome MCP example for evaluating agent answers, not a Base-provided tool, a Wallet MCP integration, a live-wallet result, or proof of safety or adoption. For a real wallet, validate the relevant scope and onchain evidence before drawing any conclusion.
