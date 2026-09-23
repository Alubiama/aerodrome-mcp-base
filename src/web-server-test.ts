import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createOverviewWebServer } from "./web-server.js";
import { overviewFixture } from "./overview-fixture.js";
import { getWalletOverview } from "./mcp/overview.js";

let reads = 0;
let mode = "normal";
const server = createOverviewWebServer({ deadlineMs: 500, read: async (input, signal) => {
  reads++;
  if (mode === "wait") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  if (mode === "fail") throw new Error("PRIVATE_INTERNAL_DETAIL");
  const fixture = overviewFixture(mode);
  const report = await getWalletOverview({ wallet: input.wallet, gauges: [fixture.gauge] }, fixture.runtime);
  if (mode === "mismatch") report.wallet = "0x0000000000000000000000000000000000000009";
  return report;
} });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const wallet = overviewFixture().wallet;
const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/overview`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
try {
  const demo = await fetch(`${origin}/api/demo`);
  assert.equal(demo.status, 200);
  const sample = await demo.json();
  assert.equal(sample.source, "SYNTHETIC");
  assert.equal(sample.report.rewards.gaugeRewards[0].amountFormatted, "2.5");
  assert.equal(reads, 0, "demo must not call live reader");
  for (const body of [{}, { wallet: "bad" }, { wallet: "0x" + "0".repeat(40) }, { wallet, gauges: [] }, { wallet, rpcUrl: "http://untrusted" }]) assert.equal((await post(body)).status, 400);
  assert.equal(reads, 0);
  assert.equal((await post({ wallet }, { origin: "https://untrusted.example" })).status, 403);
  const badHostStatus = await new Promise(resolve => {
    const req = request(`${origin}/api/demo`, { headers: { host: "untrusted.example" } }, res => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post({ wallet }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ wallet: "a".repeat(1100) })).status, 413);
  assert.equal((await fetch(`${origin}/config.json`)).status, 404);
  assert.equal((await fetch(`${origin}/basket`)).status, 200);
  assert.equal((await fetch(`${origin}/basket`,{method:"HEAD"})).status,200);
  assert.equal((await fetch(`${origin}/wallet.js`)).status,200);
  assert.equal((await fetch(`${origin}/plan-guard.js`)).status,200);
  assert.equal((await fetch(`${origin}/base-account-sdk.js`)).status,404);
  for (const route of ['inventory','quote','plan','simulate','compare']) {
    assert.equal((await fetch(`${origin}/api/basket/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:'invalid'})})).status,400);
    assert.equal((await fetch(`${origin}/api/basket/${route}`,{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({wallet})})).status,403);
  }
  assert.equal((await fetch(`${origin}/api/basket/compare`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet,tokens:['0x0000000000000000000000000000000000000002']})})).status,400);
  assert.equal((await fetch(`${origin}/.snapshot-history/`)).status, 404);
  assert.equal(reads, 0);
  const live = await post({ wallet }, { origin });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("cache-control"), "no-store");
  const result = await live.json();
  assert.equal(result.source, "LIVE_RPC");
  assert.equal(result.report.wallet, wallet);
  mode = "nativeFail";
  const partial = await (await post({ wallet })).json();
  assert.equal(partial.report.status, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(partial.report.liquidBalances[0].amountRaw, null, "read failure is not a zero");
  mode = "mismatch";
  assert.equal((await post({ wallet })).status, 502);
  mode = "fail";
  const failure = await post({ wallet });
  assert.equal(failure.status, 502);
  assert.equal((await failure.text()).includes("PRIVATE_INTERNAL_DETAIL"), false);
  mode = "wait";
  const first = post({ wallet });
  while (reads < 5) await new Promise(resolve => setTimeout(resolve, 1));
  const second = post({ wallet });
  assert.equal((await second).status,429);
  while (reads < 5) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await post({ wallet })).status, 429);
  assert.equal((await first).status, 504);

  mode = "normal";
  assert.equal((await post({ wallet })).status, 200, "timeout releases request slots");
  console.log("PASS web HTTP integration: offline demo, validation, host/origin isolation, no private files, partial evidence, failure redaction, wallet isolation, concurrency, cancellation and recovery.");
} finally { server.closeAllConnections(); server.close(); }
