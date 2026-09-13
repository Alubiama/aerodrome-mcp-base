import assert from "node:assert/strict";
import { createPinnedReadCache } from "./pinned-read-cache.js";

const call = (extra: Record<string, unknown> = {}) => ({ address: "0x0000000000000000000000000000000000000001", abi: ["function x(uint256) view returns (uint256)"], functionName: "x", args: [1n], blockNumber: 7n, ...extra });

export async function testPinnedReadCache() {
  let reads = 0, blocks = 0;
  let fail = false;
  const client = {
    readContract: async (input: any) => { reads++; if (fail) { fail = false; throw new Error("temporary"); } return { input, nested: { value: 1n } }; },
    getBlock: async () => ({ number: ++blocks }),
    label: "client"
  };
  const cached: any = createPinnedReadCache(client, 7n);
  const one = await cached.readContract(call()); one.nested.value = 9n;
  const two = await cached.readContract(call());
  assert.equal(reads, 1); assert.equal(two.nested.value, 1n); assert.equal(cached.pinnedReadCacheStats.hits, 1);
  await Promise.all([cached.readContract(call({ functionName: "concurrent" })), cached.readContract(call({ functionName: "concurrent" }))]);
  assert.equal(reads, 2);
  await cached.readContract(call({ args: [2n] })); await cached.readContract(call({ abi: ["function y() view returns (uint256)"] })); await cached.readContract(call({ account: "0x0000000000000000000000000000000000000002" })); await cached.readContract(call({ gas: 1n }));
  assert.equal(reads, 6);
  await cached.readContract(call({ blockNumber: 8n })); await cached.readContract({ ...call(), blockNumber: undefined }); await cached.readContract({ ...call(), blockTag: "latest" });
  assert.equal(reads, 9);
  fail = true; await assert.rejects(cached.readContract(call({ functionName: "retry" }))); await cached.readContract(call({ functionName: "retry" }));
  assert.equal(reads, 11);
  await cached.getBlock(); await cached.getBlock(); assert.equal(blocks, 2); assert.equal(cached.label, "client");
  const controller = new AbortController(); const abortCached: any = createPinnedReadCache(client, 7n, controller.signal);
  await abortCached.readContract(call({ functionName: "abort" })); controller.abort(); await assert.rejects(abortCached.readContract(call({ functionName: "abort" })));
  const another: any = createPinnedReadCache(client, 7n); await another.readContract(call()); assert.equal(reads, 13, "request caches do not share entries");
  const unsupported = call({ extra: () => 1 });
  await cached.readContract(unsupported);
  await cached.readContract(unsupported);
  assert.equal(reads, 15, "Unsupported identities bypass caching");
  const accountA = call({ stateOverride: [{ address: "a", balance: 1n }] });
  const accountB = call({ stateOverride: [{ address: "a", balance: 2n }] });
  await cached.readContract(accountA); await cached.readContract(accountB);
  assert.equal(reads, 17, "State overrides remain distinct");
  const bound = createPinnedReadCache({ secret: 7, get label() { return this.secret; }, getChainId() { return this.secret; } }, 7n);
  assert.equal(bound.label, 7); assert.equal(bound.getChainId(), 7);
}

testPinnedReadCache().then(() => console.log("Pinned read cache tests passed.")).catch(error => { console.error(error); process.exit(1); });
