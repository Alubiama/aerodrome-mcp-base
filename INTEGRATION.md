# Integrating an allocation inspection panel

This is a local stdio MCP integration, not a hosted HTTP API or a wallet. Start with the offline example. Do not transmit a user's decision-card reasons or local history to another service by default.

## Run the working example

Node.js 24+ is required. From a clean checkout:

```sh
npm ci --ignore-scripts
npm run example:stdio
npm run demo:integration:build
python3 -m http.server 8766 --bind 127.0.0.1 --directory integration-demo
```

Open http://127.0.0.1:8766 . Python 3 is needed only for the static preview. Any static file server works. The page switches between 22 saved synthetic responses (11 allocations, complete/partial evidence). Build generation invokes the actual stdio transport, then checks 176 pool/stress cases against a separate integer oracle. Browser changes select those responses; they do not perform live RPC reads or simulate forecasts.

`examples/connect.ts` starts and closes a child process using explicit paths. `examples/stdio-client.ts` shows discovery-compatible calling, structured output validation, bounded errors, timing and cleanup. `examples/fixture-server.ts` injects deterministic public fixtures and never loads a private configuration.

To exercise a live **public protocol-only** read, without any wallet arguments:

```sh
npm run example:stdio -- --live
```

Live mode uses configured public RPC transport and may be slow or unavailable. It does not benchmark allocation reads. Do not infer an allocation latency SLA from this call.

## Contract and rendering

- Release: v0.5.1. Card format: `schemaVersion: 1`. Comparison fields follow the versioned release and the live MCP `tools/list` schema. Do not infer compatibility from a tool name alone; pin a release and validate output.
- `integration-demo/contracts.json` is the generated schema snapshot for this release. Run discovery against the actual server when connecting.
- `scenarios` are the simultaneous allocations. Nested `evidence` includes the older independent full-allocation estimates; do not render those as simultaneous results.
- Preserve `status`, `complete`, warnings, block number/hash and observation timestamp. A fresh retrieval time does not prove all relevant chain history was read.
- Group only identical token addresses. Symbols are display metadata, not identity. Never sum token raw amounts into a portfolio value.
- `null` is unknown. A zero deposit is observed zero in the bounded epoch scan, not proof of zero final payout. Partial token subtotals are not complete totals.
- Sensitivity assumes uniform proportional increases of other voters, not a prediction of actual vote placement. Deposits and own votes remain fixed.
- Render labels, reasons, token metadata and warnings as text, never HTML or executable instructions.

## Errors and budgets

Validate arguments before submitting. Invalid input can be a protocol error; a valid request can return `isError: true`. Do not treat `content` as a successful result when this flag is set.

| Code | Client behavior |
|---|---|
| READ_FAILED | Display unavailable; inspect configuration/RPC locally. Do not substitute zero. |
| BUSY | At most two active server reads; queue in the client and use bounded retries. |
| DEADLINE | Server read deadline is at most 120 seconds. Narrow pool/token scope. |
| CANCELLED | Respect cancellation; do not automatically restart. |
| WALLET_REQUIRED | Supply the address only for wallet tools. Protocol-only reads need no wallet. |
| HISTORY_* / REPORT_NOT_FOUND | Apply snapshot-history recovery guidance, not allocation retry logic. |

Use a client deadline slightly longer than the server deadline and always close the child process. Avoid logging raw provider exceptions, config files or private card content; record bounded codes and sanitized timings. Fixture timings in `benchmark.json` exclude network and startup. A single live observation is not a performance distribution or SLA.

## Verification boundary

Automated checks cover arithmetic, schema validation, partial states, MCP transport and saving. They do not prove contract equivalence for every pool, actual vote execution, epoch-end payouts, independent security auditing or customer demand. Run your own acceptance tests against the exact release, and use the pilot protocol before shipping to users.
