import assert from "node:assert/strict";
import type { ToolRuntime } from "./mcp/data.js";
import { getPoolDirectory, poolDirectoryInputSchema } from "./mcp/pools.js";
import { overviewFixture, fixtureAddress as address } from "./overview-fixture.js";

function fixture(mode = "normal", count = 3) {
  const base = overviewFixture(mode);
  const runtime: ToolRuntime = base.runtime;
  const original = runtime.client.readContract;
  runtime.client.readContract = async (call: any) => {
    assert.equal(call.blockNumber, 123n);
    switch (call.functionName) {
      case "length": return BigInt(count);
      case "pools":
        if (mode === "failedSlot" && call.args[0] === 1n) throw new Error("synthetic failure");
        return mode === "invalidPool" ? "invalid" : address(Number(call.args[0]) + 10);
      case "gauges": return mode === "zeroGauge" ? address(0) : mode === "invalidGauge" ? "bad" : address(30);
      case "weights": return 5n;
      case "isGauge": assert.equal(call.args[0], address(30)); return true;
      case "isAlive":
        assert.equal(call.args[0], address(30));
        if (mode === "aliveFail") throw new Error("missing liveness");
        return mode !== "dead";
      case "token0":
      case "token1":
        if (mode === "pairFail") throw new Error("unsupported pair");
        return address(call.functionName === "token0" ? 40 : 41);
      case "decimals": if (mode === "unknownDecimals") throw new Error("no metadata"); return 18;
      case "symbol": return "DEMO";
      default: return original(call);
    }
  };
  return runtime;
}
const first = await getPoolDirectory({ limit: 2 }, fixture());
assert.equal(first.status, "VERIFIED_POINT_IN_TIME");
assert.deepEqual(first.pools.map(row => row.index), ["2", "1"]);
assert.equal(first.nextBeforeIndex, "1");
assert.equal(first.pools[0].token0?.address, address(40));
assert.equal(first.pools[0].gaugeAlive, true);
const last = await getPoolDirectory({ beforeIndex: first.nextBeforeIndex!, limit: 2 }, fixture());
assert.deepEqual(last.pools.map(row => row.index), ["0"]);
assert.equal(last.hasMore, false);
const since = await getPoolDirectory({ sinceIndex: "2" }, fixture());
assert.deepEqual(since.pools.map(row => row.index), ["2"]);
assert.equal(since.nextBeforeIndex, null);
const failed = await getPoolDirectory({ limit: 2 }, fixture("failedSlot"));
assert.equal(failed.pools[1].pool, null);
assert.equal(failed.nextBeforeIndex, "1");
assert.equal(failed.status, "PARTIAL_BOUNDED_SCOPE");
for (const mode of ["aliveFail", "pairFail", "unknownDecimals", "zeroGauge", "invalidGauge", "invalidPool"]) {
  const result = await getPoolDirectory({ limit: 1 }, fixture(mode));
  assert.equal(result.status, "PARTIAL_BOUNDED_SCOPE", mode);
  assert.equal(result.pools[0].status, "PARTIAL", mode);
  if (mode === "unknownDecimals") assert.equal(result.pools[0].token0?.decimals, null);
}
assert.equal((await getPoolDirectory({}, fixture("dead"))).pools[0].gaugeAlive, false);
const empty = await getPoolDirectory({}, fixture("normal", 0));
assert.equal(empty.scanned.count, 0);
assert.deepEqual(empty.pools, []);
assert.equal(empty.hasMore, false);
assert.equal((await getPoolDirectory({ limit: 16 }, fixture("normal", 20))).scanned.count, 16);
for (const input of [{ limit: 17 }, { beforeIndex: "-1" }, { beforeIndex: (1n << 256n).toString() }, { sinceIndex: "9".repeat(100) }]) {
  assert.equal(poolDirectoryInputSchema.safeParse(input).success, false);
}
await assert.rejects(getPoolDirectory({ beforeIndex: "4" }, fixture()), /beforeIndex/);
await assert.rejects(getPoolDirectory({ beforeIndex: "1", sinceIndex: "2" }, fixture()), /sinceIndex/);
await assert.rejects(getPoolDirectory({}, fixture("wrongChain")), /chainId/);
await assert.rejects(getPoolDirectory({}, fixture("reorg")), /block changed/);
const missing = fixture();
missing.client.getBlock = async () => ({ number: 123n, timestamp: 1800n, hash: null as any });
await assert.rejects(getPoolDirectory({}, missing), /block hash/);
const cancelled = fixture();
cancelled.signal = AbortSignal.abort();
await assert.rejects(getPoolDirectory({}, cancelled));
const late = fixture();
const controller = new AbortController();
late.signal = controller.signal;
const block = late.client.getBlock;
late.client.getBlock = async (args: any) => { const value = await block(args); if (args.blockNumber) controller.abort(); return value; };
await assert.rejects(getPoolDirectory({}, late));
console.log("Pool directory tests passed: gauge target, pinned reads, pagination, partial metadata, bounds, reorg and cancellation.");
