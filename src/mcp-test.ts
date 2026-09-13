import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AppConfig } from "./types.js";
import { getPoolComparison, getWalletSnapshot, getProtocolStatus, getVotingPosition, getWalletRewards, unixSecondsToIso } from "./mcp/data.js";
import { createAeroMcpServer } from "./mcp/server.js";
import { poolComparisonSchema, poolComparisonInputSchema, walletSnapshotSchema } from "./mcp/schema.js";
import { testWalletChanges } from "./wallet-changes-test.js";
import { makeClient } from "./client.js";

const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const VE = "0x0000000000000000000000000000000000000001";
const OWNER = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const GAUGE = "0x0000000000000000000000000000000000000004";
const BRIBE = "0x0000000000000000000000000000000000000005";
const REWARD_TOKEN = "0x0000000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";

function testConfig(tokenIds = ["1"]): AppConfig {
  return {
    walletAddress: OWNER,
    baseRpcUrl: "https://mainnet.base.org",
    contracts: { voter: VOTER, router: ROUTER, defaultFactory: FACTORY },
    tokens: { USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    veNftTokenIds: tokenIds,
    gaugeAddresses: [],

  };
}

function votingClient(poolVoteError: Error, overrides: Record<string, unknown> = {}) {
  return {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 123n, timestamp: 1_800n, hash: null }),
    readContract: async (call: { functionName: string }) => {
      if (Object.hasOwn(overrides, call.functionName)) return overrides[call.functionName];
      switch (call.functionName) {
        case "ve": return VE;
        case "totalWeight": return 100n;
        case "maxVotingNum": return 4n;
        case "epochStart": return 1_000n;
        case "epochNext": return 2_000n;
        case "epochVoteStart": return 1_100n;
        case "epochVoteEnd": return 1_900n;
        case "usedWeights": return 10n;
        case "lastVoted": return 1_500n;
        case "ownerOf": return OWNER;
        case "balanceOfNFT": return 20n;
        case "poolVote": throw poolVoteError;
        default: throw new Error(`Unexpected mock call: ${call.functionName}`);
      }
    }
  };
}

function rewardsClient(gaugeReadFails = false, tokenOwner = OWNER) {
  return {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 123n, timestamp: 1_800n, hash: null }),
    readContract: async (call: { address: string; functionName: string; args?: unknown[] }) => {
      switch (call.functionName) {
        case "maxVotingNum": return 4n;
        case "ve": return VE;
        case "ownerOf": return tokenOwner;
        case "usedWeights": return 10n;
        case "poolVote": {
          if (call.args?.[1] === 0n) return POOL;
          throw new Error("execution reverted: index out of bounds");
        }
        case "gauges": {
          if (gaugeReadFails) throw new Error("execution reverted");
          return GAUGE;
        }
        case "gaugeToBribe": return BRIBE;
        case "gaugeToFees": return ZERO;
        case "rewardsListLength": return 1n;
        case "rewards": return REWARD_TOKEN;
        case "isGauge": return true;
        case "rewardToken": return REWARD_TOKEN;
        case "earned": return call.address.toLowerCase() === BRIBE.toLowerCase() ? 5n : 7n;
        case "symbol": return "RWD";
        case "decimals": return 18;
        default: throw new Error(`Unexpected reward mock call: ${call.functionName}`);
      }
    }
  };
}

function protocolClient(routerVoter = VOTER) {
  return {
    getChainId: async () => 8453,
    getBlock: async () => ({ number: 123n, timestamp: 1_800n, hash: `0x${"ab".repeat(32)}` }),
    readContract: async (call: { address: string; functionName: string }) => {
      switch (call.functionName) {
        case "voter": return routerVoter;
        case "defaultFactory": return FACTORY;
        case "ve": return VE;
        case "maxVotingNum": return 60n;
        case "length": return 1_914n;
        case "totalWeight": return 1_000n;
        case "epochStart": return 1_000n;
        case "epochNext": return 2_000n;
        case "epochVoteStart": return 1_100n;
        case "epochVoteEnd": return 1_900n;
        default: throw new Error(`Unexpected protocol mock call: ${call.functionName} at ${call.address}`);
      }
    }
  };
}

async function testDataSafety() {
  assert.equal(unixSecondsToIso(0n, "timestamp"), "1970-01-01T00:00:00.000Z");
  assert.throws(() => unixSecondsToIso(253_402_300_800n, "timestamp"), /supported Unix timestamp range/);

  const protocol = await getProtocolStatus({ cfg: testConfig(), client: protocolClient() });
  assert.equal(protocol.chainId, 8453);
  assert.equal(protocol.protocol.maxPoolsPerVote, "60");
  assert.equal(protocol.epoch.normalVotingOpen, true);
  await assert.rejects(
    getProtocolStatus({ cfg: testConfig(), client: protocolClient(OWNER) }),
    /Router\.voter does not match/
  );

  await assert.rejects(
    getVotingPosition({}, {
      cfg: testConfig(),
      client: {
        getChainId: async () => 8453,
        getBlock: async () => ({ number: 123n, timestamp: 253_402_300_800n, hash: null })
      }
    }),
    /Base block timestamp is outside the supported Unix timestamp range/
  );

  for (const service of [getVotingPosition, getWalletRewards] as const) {
    await assert.rejects(
      service({}, {
        cfg: testConfig(),
        client: { getChainId: async () => 1 }
      } as never),
      /Wrong chainId from RPC: 1/
    );
  }

  await assert.rejects(
    getVotingPosition({}, {
      cfg: testConfig(),
      client: votingClient(new Error("execution reverted"), { epochVoteEnd: 2_100n })
    }),
    /epoch boundaries are inconsistent/
  );

  await assert.rejects(
    getWalletRewards({}, {
      cfg: testConfig(Array.from({ length: 17 }, (_, index) => String(index + 1))),
      client: { getBlock: async () => ({ number: 123n, timestamp: 1_800n, hash: null }) }
    }),
    /between 1 and 16 items/
  );

  await assert.rejects(
    getVotingPosition({}, { cfg: testConfig(), client: votingClient(new Error("network error")) }),
    /Current poolVote read failed/
  );

  const boundedEnd = await getVotingPosition({}, {
    cfg: testConfig(),
    client: votingClient(new Error("execution reverted: index out of bounds"))
  });
  assert.equal(boundedEnd.positions[0].pools.length, 0);
  assert.equal(boundedEnd.status, "PARTIAL_POINT_IN_TIME");
  assert.ok(boundedEnd.warnings.some((warning) => warning.includes("used weight but no current poolVote")));

  const rewardsConfig = testConfig();
  rewardsConfig.gaugeAddresses = [GAUGE];
  const rewards = await getWalletRewards({ includeZero: true, maxItems: 10 }, {
    cfg: rewardsConfig,
    client: rewardsClient()
  });
  assert.equal(rewards.votingRewards.length, 1);
  assert.equal(rewards.votingRewards[0].amountRaw, "5");
  assert.equal(rewards.gaugeRewards.length, 1);
  assert.equal(rewards.gaugeRewards[0].amountRaw, "7");
  assert.equal(rewards.totals.examinedItems, 2);
  assert.equal(rewards.status, "VERIFIED_BOUNDED_SCOPE");

  await assert.rejects(
    getWalletRewards({}, { cfg: testConfig(), client: rewardsClient(false, POOL) }),
    /is not owned by the configured wallet/
  );

  await assert.rejects(
    getWalletRewards({ includeZero: true, maxItems: 1 }, { cfg: rewardsConfig, client: rewardsClient() }),
    /Reward scan exceeds maxItems=1/
  );

  const missingGauge = await getWalletRewards({}, { cfg: testConfig(), client: rewardsClient(true) });
  assert.equal(missingGauge.status, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(missingGauge.votingRewards.length, 0);
  assert.ok(missingGauge.warnings.some((warning) => warning.includes("Could not verify the gauge mapping")));
}

const fixture = {
  status: "VERIFIED_POINT_IN_TIME",
  readOnly: true,
  chainId: 8453,
  observation: { blockNumber: "123" },
  coverage: { scope: "fixture" },
  warnings: []
};

async function connectTestServer(server: ReturnType<typeof createAeroMcpServer>) {
  const client = new Client({ name: "aero-cancellation-test", version: "0.1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function testRpcCancellationIsolation() {
  const originalFetch = globalThis.fetch;
  const controllers = [new AbortController(), new AbortController()];
  const requests: Array<{ signal: AbortSignal; respond: () => void }> = [];
  let started!: () => void;
  const bothStarted = new Promise<void>((resolve) => { started = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Parallel RPC fetches did not remain isolated")), 5_000);
  });
  try {
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        requests.push({ signal, respond: () => {
          const answer = (item: { id: number }) => ({ jsonrpc: "2.0", id: item.id, result: "0x2105" });
          resolve(new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), {
            headers: { "Content-Type": "application/json" }
          }));
        } });
        if (requests.length === 2) started();
      });
    };
    const first = makeClient(testConfig(), { batchRpc: true, signal: controllers[0].signal }).getChainId();
    const firstRejected = assert.rejects(first);
    const second = makeClient(testConfig(), { batchRpc: true, signal: controllers[1].signal }).getChainId();
    // Observe errors immediately, including on a failing isolation implementation.
    const secondResult = second.then((value) => ({ value }), (error) => ({ error }));
    await Promise.race([bothStarted, timeout]);
    controllers[0].abort();
    await firstRejected;
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    requests[1].respond();
    assert.deepEqual(await secondResult, { value: 8453 });
  } finally {
    controllers.forEach((controller) => controller.abort());
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
}

async function testRequestControls() {
  function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const originalFetch = globalThis.fetch;
  const started = latch();
  const stopped = latch();
  let fetches = 0;
  let attempts = 0;
  const server = createAeroMcpServer({
    protocolStatus: async (signal) => {
      if (++attempts > 1) return fixture;
      const cfg = testConfig();
      return getProtocolStatus({ cfg, signal, client: makeClient(cfg, { signal, batchRpc: true }) });
    },
    votingPosition: async () => fixture,
    walletRewards: async () => fixture
  });
  const client = await connectTestServer(server);
  try {
    globalThis.fetch = async (_input, init) => {
      fetches += 1;
      const signal = init?.signal;
      assert.ok(signal, "RPC fetch must receive a cancellation signal");
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { stopped.resolve(); reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };
    const controller = new AbortController();
    const pending = client.callTool({ name: "aerodrome_protocol_status", arguments: {} }, { signal: controller.signal });
    const rejected = assert.rejects(pending);
    await started.promise;
    controller.abort();
    await Promise.all([rejected, stopped.promise]);
    // Let the aborted transport and handler unwind before checking recovery.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 1, "Cancellation must not start fallback RPC requests");
    const next = await client.callTool({ name: "aerodrome_protocol_status", arguments: {} });
    assert.equal(next.isError, undefined, "Same server must remain usable after cancellation");
  } finally {
    globalThis.fetch = originalFetch;
    await client.close();
    await server.close();
  }

  let active = 0;
  const bothStarted = latch();
  const boundedServer = createAeroMcpServer({
    protocolStatus: async (signal) => {
      active += 1;
      if (active === 2) bothStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { active -= 1; reject(signal.reason); }, { once: true });
      });
      return fixture;
    },
    votingPosition: async () => fixture,
    walletRewards: async () => fixture
  }, { deadlineMs: 100 });
  const boundedClient = await connectTestServer(boundedServer);
  try {
    const first = boundedClient.callTool({ name: "aerodrome_protocol_status", arguments: {} });
    const second = boundedClient.callTool({ name: "aerodrome_protocol_status", arguments: {} });
    await bothStarted.promise;
    const busy = await boundedClient.callTool({ name: "aerodrome_protocol_status", arguments: {} });
    assert.equal(busy.isError, true);
    assert.match(JSON.stringify(busy.content), /BUSY/);
    for (const timedOut of await Promise.all([first, second])) {
      assert.equal(timedOut.isError, true);
      assert.match(JSON.stringify(timedOut.content), /DEADLINE/);
    }
    assert.equal(active, 0);
    assert.equal((await boundedClient.callTool({ name: "aerodrome_voting_position", arguments: {} })).isError, undefined);
  } finally {
    await boundedClient.close();
    await boundedServer.close();
  }
}

async function testSnapshot() {
  function snapshotRuntime(options: { partial?: boolean; votingPartial?: boolean; rewardsPartial?: boolean; reorg?: boolean; missingHash?: boolean } = {}) {
    const calls: string[] = [];
    let latestReads = 0;
    let hashChecks = 0;
    const hash = `0x${"ab".repeat(32)}`;
    const base = protocolClient();
    const rewardClient = rewardsClient(options.partial);
    return {
      calls,
      counts: () => ({ latestReads, hashChecks }),
      runtime: {
        cfg: { ...testConfig(), gaugeAddresses: [GAUGE] },
        client: {
          getChainId: base.getChainId,
          getBlock: async (input: { blockTag?: string; blockNumber?: bigint }) => {
            if (input.blockTag === "latest") latestReads++;
            else { assert.equal(input.blockNumber, 123n); hashChecks++; }
            return { number: 123n, timestamp: 1800n, hash: options.missingHash ? null : options.reorg && hashChecks ? `0x${"cd".repeat(32)}` : hash };
          },
          readContract: async (call: { address: string; functionName: string; blockNumber?: bigint; args?: unknown[] }) => {
            assert.equal(call.blockNumber, 123n, `${call.functionName} must be pinned`);
            calls.push(call.functionName);
            if ((options.votingPartial && call.functionName === "votes") || (options.rewardsPartial && call.functionName === "earned")) throw new Error("execution reverted");
            if (["voter", "defaultFactory", "totalWeight", "length", "epochStart", "epochNext", "epochVoteStart", "epochVoteEnd"].includes(call.functionName)) return base.readContract(call);
            if (call.functionName === "lastVoted") return 1500n;
            if (call.functionName === "balanceOfNFT") return 20n;
            if (call.functionName === "votes") return 10n;
            if (call.functionName === "weights") return 100n;
            if (call.functionName === "isAlive") return true;
            return rewardClient.readContract(call);
          }
        }
      }
    };
  }
  const test = snapshotRuntime();
  const value = await getWalletSnapshot({}, test.runtime);
  walletSnapshotSchema.parse(value);
  await testWalletChanges(value, test.runtime.cfg);
  assert.equal(value.status, "VERIFIED_BOUNDED_SCOPE");
  assert.ok(value.warnings.length > 0, "Coverage warnings alone are not partial failures");
  assert.deepEqual(test.counts(), { latestReads: 1, hashChecks: 1 });
  for (const section of [value.protocol, value.voting, value.rewards]) assert.deepEqual(section.observation, value.observation);
  assert.ok(test.calls.includes("symbol") && test.calls.includes("decimals"), "Metadata cache must not bypass pinned reads");
  const again = snapshotRuntime();
  await getWalletSnapshot({}, again.runtime);
  assert.ok(again.calls.includes("decimals"), "Every snapshot reads fresh pinned metadata");
  const partial = await getWalletSnapshot({}, snapshotRuntime({ partial: true }).runtime);
  assert.equal(partial.status, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(partial.voting.status, "PARTIAL_POINT_IN_TIME");
  assert.equal(partial.rewards.status, "PARTIAL_BOUNDED_SCOPE");
  walletSnapshotSchema.parse(partial);
  const votingPartial = await getWalletSnapshot({}, snapshotRuntime({ votingPartial: true }).runtime);
  assert.equal(votingPartial.status, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(votingPartial.rewards.status, "VERIFIED_BOUNDED_SCOPE");
  const rewardsPartial = await getWalletSnapshot({}, snapshotRuntime({ rewardsPartial: true }).runtime);
  assert.equal(rewardsPartial.status, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(rewardsPartial.voting.status, "VERIFIED_POINT_IN_TIME");
  await assert.rejects(getWalletSnapshot({}, snapshotRuntime({ reorg: true }).runtime), /block changed/);
  await assert.rejects(getWalletSnapshot({}, snapshotRuntime({ missingHash: true }).runtime), /valid block hash/);
  assert.equal(walletSnapshotSchema.safeParse({ ...value, unexpected: true }).success, false);
  assert.equal(walletSnapshotSchema.safeParse({ ...value, rewards: { ...value.rewards, wallet: "invalid" } }).success, false);
  let malformed = false;
  const server = createAeroMcpServer({
    protocolStatus: async () => ({}), votingPosition: async () => ({}), walletRewards: async () => ({}),
    walletSnapshot: async () => malformed ? { ...value, extra: "private detail" } : value
  });
  const client = await connectTestServer(server);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.find(t => t.name === "aerodrome_wallet_snapshot")?.outputSchema);
    const result = await client.callTool({ name: "aerodrome_wallet_snapshot", arguments: {} });
    assert.equal(result.isError, undefined);
    walletSnapshotSchema.parse(result.structuredContent);
    malformed = true;
    const invalid = await client.callTool({ name: "aerodrome_wallet_snapshot", arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.stringify(invalid).includes("private detail"), false);
  } finally { await client.close(); await server.close(); }
}

async function testPoolComparison() {
  const otherPool = "0x0000000000000000000000000000000000000007";
  const otherGauge = "0x0000000000000000000000000000000000000008";
  const input = { pools: [POOL, otherPool] };
  function setup(mode = "valid") {
    let latest = 0;
    let rechecks = 0;
    let reads = 0;
    const controller = new AbortController();
    const base = protocolClient();
    const runtime = { cfg: testConfig(), signal: controller.signal, client: {
      getChainId: async () => mode === "wrongChain" ? 1 : 8453,
      getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
        if (args.blockTag === "latest") latest++;
        else { assert.equal(args.blockNumber, 123n); rechecks++; }
        return { number: 123n, timestamp: 1800n, hash: mode === "missingHash" ? null : `0x${(mode === "reorg" && rechecks ? "cd" : "ab").repeat(32)}` };
      },
      readContract: async (call: { address: string; functionName: string; args?: string[]; blockNumber?: bigint }) => {
        reads++;
        assert.equal(call.blockNumber, 123n);
        assert.equal(call.address, VOTER === call.address ? VOTER : ROUTER);
        if (call.functionName === "totalWeight" && mode === "zero") return 0n;
        if (call.functionName === "gauges") {
          if (mode === "cancel") { controller.abort(); throw new Error("private provider error"); }
          if (call.args?.[0] === otherPool && mode === "failure") throw new Error("private provider error");
          if (call.args?.[0] === otherPool && mode === "unregistered") return ZERO;
          return call.args?.[0] === POOL ? GAUGE : otherGauge;
        }
        if (call.functionName === "isGauge") return mode !== "inconsistent";
        if (call.functionName === "isAlive") return call.args?.[0] === GAUGE;
        if (call.functionName === "weights") return mode === "zero" ? 0n : call.args?.[0] === POOL ? 100n : 333n;
        if (call.functionName === "gaugeToBribe") return BRIBE;
        if (call.functionName === "gaugeToFees") return ZERO;
        return base.readContract(call);
      }
    } };
    return { runtime, counts: () => ({ latest, rechecks, reads }) };
  }
  const test = setup();
  const value = await getPoolComparison(input, test.runtime);
  poolComparisonSchema.parse(value);
  assert.equal(value.status, "VERIFIED_BOUNDED_SCOPE");
  assert.equal(test.counts().latest, 1);
  assert.equal(test.counts().rechecks, 1);
  assert.deepEqual(value.pools.map(row => row.pool), input.pools);
  assert.deepEqual(value.pools.map(row => row.shareOfProtocolWeightBps), ["1000", "3330"]);
  assert.equal(value.pools[1].gaugeAlive, false, "Dead gauge is verified evidence, not a missing read");
  assert.equal(value.pools[0].feeContract, null);
  for (const mode of ["failure", "unregistered", "inconsistent"]) {
    const result = await getPoolComparison(input, setup(mode).runtime);
    poolComparisonSchema.parse(result);
    assert.equal(result.status, "PARTIAL_BOUNDED_SCOPE");
    assert.equal(result.pools[1].status, mode === "unregistered" ? "NOT_REGISTERED" : "READ_FAILED");
    assert.equal(result.pools[1].voteWeightRaw, null);
    assert.equal(JSON.stringify(result).includes("private provider error"), false);
  }
  const zero = await getPoolComparison(input, setup("zero").runtime);
  assert.equal(zero.pools[0].voteWeightRaw, "0");
  assert.equal(zero.pools[0].shareOfProtocolWeightBps, null);
  for (const mode of ["wrongChain", "reorg", "missingHash", "cancel"]) await assert.rejects(getPoolComparison(input, setup(mode).runtime));
  for (const pools of [[], [POOL], [POOL, POOL], [POOL, ZERO], [POOL, "invalid"], Array(17).fill(POOL)]) {
    const invalid = setup();
    assert.equal(poolComparisonInputSchema.safeParse({ pools }).success, false);
    await assert.rejects(getPoolComparison({ pools }, invalid.runtime));
    assert.equal(invalid.counts().reads, 0, "Invalid input must fail before reads");
  }
  let dispatches = 0;
  let malformed = false;
  const server = createAeroMcpServer({
    protocolStatus: async () => ({}), votingPosition: async () => ({}), walletRewards: async () => ({}),
    poolComparison: async () => { dispatches++; return malformed ? { ...value, extra: true } : value; }
  });
  const client = await connectTestServer(server);
  try {
    assert.ok((await client.listTools()).tools.find(t => t.name === "aerodrome_compare_pools")?.outputSchema);
    const result = await client.callTool({ name: "aerodrome_compare_pools", arguments: input });
    assert.equal(result.isError, undefined);
    poolComparisonSchema.parse(result.structuredContent);
    const invalid = await client.callTool({ name: "aerodrome_compare_pools", arguments: { pools: [POOL, POOL] } });
    assert.equal(invalid.isError, true);
    assert.equal(dispatches, 1);
    malformed = true;
    assert.equal((await client.callTool({ name: "aerodrome_compare_pools", arguments: input })).isError, true);
  } finally { await client.close(); await server.close(); }
}

async function main() {
  await testRequestControls();
  await testRpcCancellationIsolation();
  await testDataSafety();
  await testSnapshot();
  await testPoolComparison();
  const mcpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp");
  const mcpSource = fs.readdirSync(mcpDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fs.readFileSync(path.join(mcpDir, name), "utf8"))
    .join("\n");
  for (const forbidden of [
    "writeContract",
    "sendTransaction",
    "sendRawTransaction",
    "eth_sendTransaction",
    "prepareTransactionRequest",
    "encodeFunctionData",
    "../tx.js"
  ]) {
    assert.equal(mcpSource.includes(forbidden), false, `MCP source must not contain ${forbidden}`);
  }
  const calls: string[] = [];
  const server = createAeroMcpServer({
    protocolStatus: async () => { calls.push("status"); return fixture; },
    votingPosition: async (input) => {
      calls.push(`position:${input.tokenIds?.join(",") ?? "configured"}`);
      return { ...fixture, positions: [] };
    },
    walletRewards: async (input) => {
      calls.push(`rewards:${input.includeZero}:${input.maxItems}`);
      return { ...fixture, votingRewards: [], gaugeRewards: [] };
    }
  });
  const client = new Client({ name: "aerodrome-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "aerodrome_compare_pools",
    "aerodrome_protocol_status",
    "aerodrome_voting_position",
    "aerodrome_wallet_changes",
    "aerodrome_wallet_rewards",
    "aerodrome_wallet_snapshot"
  ]);
  assert.ok(listed.tools.every((tool) =>
    tool.annotations?.readOnlyHint === (tool.name !== "aerodrome_wallet_changes") &&
    tool.annotations?.destructiveHint === false &&
    tool.annotations?.idempotentHint === (tool.name !== "aerodrome_wallet_changes") &&
    tool.annotations?.openWorldHint === true
  ));

  const status = await client.callTool({ name: "aerodrome_protocol_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal((status.structuredContent as typeof fixture).chainId, 8453);

  const position = await client.callTool({
    name: "aerodrome_voting_position",
    arguments: { tokenIds: ["101"] }
  });
  assert.equal(position.isError, undefined);

  const invalid = await client.callTool({
    name: "aerodrome_voting_position",
    arguments: { tokenIds: ["not-a-token-id"] }
  });
  assert.equal(invalid.isError, true);

  for (const tokenId of ["0", "9".repeat(78)]) {
    const invalidBoundary = await client.callTool({
      name: "aerodrome_voting_position",
      arguments: { tokenIds: [tokenId] }
    });
    assert.equal(invalidBoundary.isError, true);
  }

  const invalidMaxItems = await client.callTool({
    name: "aerodrome_wallet_rewards",
    arguments: { maxItems: 0 }
  });
  assert.equal(invalidMaxItems.isError, true);

  const rewards = await client.callTool({ name: "aerodrome_wallet_rewards", arguments: {} });
  assert.equal(rewards.isError, undefined);
  assert.deepEqual(calls, ["status", "position:101", "rewards:false:100"]);

  await client.close();
  await server.close();

  const failingServer = createAeroMcpServer({
    protocolStatus: async () => { throw new Error(`RPC failure ${"x".repeat(700)}\nprivate detail`); },
    votingPosition: async () => fixture,
    walletRewards: async () => fixture
  });
  const failingClient = new Client({ name: "aerodrome-mcp-failure-test", version: "0.1.0" });
  const [failingClientTransport, failingServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([failingServer.connect(failingServerTransport), failingClient.connect(failingClientTransport)]);
  const failed = await failingClient.callTool({ name: "aerodrome_protocol_status", arguments: {} });
  assert.equal(failed.isError, true);
  const failedText = failed.content[0]?.type === "text" ? failed.content[0].text : "";
  assert.match(failedText, /^Aerodrome READ_FAILED:/);
  assert.equal(failedText.includes("RPC failure"), false);
  assert.ok(failedText.length <= 523);
  assert.equal(failedText.includes("private detail"), false);
  await failingClient.close();
  await failingServer.close();

  const projectRoot = path.resolve(mcpDir, "../..");
  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", path.join(projectRoot, "node_modules/tsx/dist/loader.mjs"), path.join(mcpDir, "index.ts")],
    cwd: os.tmpdir(),
    stderr: "pipe"
  });
  let childStderr = "";
  stdioTransport.stderr?.on("data", (chunk) => { childStderr += String(chunk); });
  const stdioClient = new Client({ name: "aerodrome-mcp-stdio-test", version: "0.1.0" });
  await stdioClient.connect(stdioTransport);
  const stdioTools = await stdioClient.listTools();
  assert.deepEqual(stdioTools.tools.map((tool) => tool.name).sort(), listed.tools.map((tool) => tool.name).sort());
  await stdioClient.close();
  assert.match(childStderr, /Aerodrome read-only MCP v0\.1 running on stdio/);
  console.log("MCP tests passed: data safety, Base chain checks, 6 tools, strict snapshot/comparison schemas, read-only annotations, bounded errors, and cross-cwd stdio lifecycle.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
