import { getWalletOverview, walletOverviewSchema } from "./mcp/overview.js";
import { overviewFixture } from "./overview-fixture.js";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAeroMcpServer } from "./mcp/server.js";
import { getWalletChanges, walletChangesSchema } from "./mcp/changes.js";
import { configSchema } from "./config.js";
import type { AppConfig } from "./types.js";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const contracts = { voter: address(10), router: address(11), defaultFactory: address(12) };
const cfg: AppConfig = { walletAddress: address(2), veNftTokenIds: ["1"], gaugeAddresses: [address(4)], contracts, tokens: {}, baseRpcUrl: "https://mainnet.base.org" };
const epoch = { start: "2026-01-01T00:00:00.000Z", next: "2026-01-08T00:00:00.000Z", normalVoteStart: "2026-01-01T01:00:00.000Z", normalVoteEnd: "2026-01-07T23:00:00.000Z", normalVotingOpen: true };
function snapshot(step: number) {
  const observation = { observedAt: "2026-01-02T00:00:00.000Z", blockNumber: String(100 + step), blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: "2026-01-02T00:00:00.000Z" };
  const common = { readOnly: true, chainId: 8453, observation, warnings: [] };
  return { ...common, status: "VERIFIED_BOUNDED_SCOPE",
    protocol: { ...common, status: "VERIFIED_POINT_IN_TIME", chain: "Base mainnet", contracts: { ...contracts, votingEscrow: address(1) }, protocol: { poolCount: "2", totalVoteWeightRaw: "100", maxPoolsPerVote: "16" }, epoch, coverage: { scope: "synthetic", pricing: "not included", transactions: "not included" } },
    voting: { ...common, status: "VERIFIED_POINT_IN_TIME", epoch, totalProtocolWeightRaw: "100", positions: [{ tokenId: "1", owner: address(2), currentVotingPowerRaw: "20", usedWeightRaw: "0", shareOfProtocolWeightBps: "0", lastVotedAt: null, votedThisEpoch: false, pools: [] }], coverage: { scope: "synthetic", historicalVotes: "not scanned", profitability: "not calculated" } },
    rewards: { ...common, status: "VERIFIED_BOUNDED_SCOPE", wallet: address(2), configuredTokenIds: ["1"], votingRewards: [], gaugeRewards: [{ gauge: address(4), token: address(6), symbol: "DEMO", decimals: 0, decimalsSource: "ONCHAIN", amountRaw: step ? "125" : "100", amountFormatted: step ? "125" : "100" }], totals: { examinedItems: 1, votingRewardItems: 0, gaugeRewardItems: 1 }, coverage: { scope: "synthetic", historicalUnclaimedPools: "not scanned", tokenPrices: "not included", displayMetadata: "synthetic", realizableValue: "not calculated" } },
    coverage: { scope: "synthetic", consistency: "synthetic fixture, not Base data", historicalRewards: "not scanned", pricing: "not included" } };
}
async function main() {
  const input = { walletAddress: address(2), veNftTokenIds: ["1"] };
  configSchema.parse(input);
  for (const invalid of [{ ...input, privateKey: "never-a-real-key" }, { ...input, veNftTokenIds: ["0"] }, { ...input, veNftTokenIds: ["1", "01"] }, { ...input, walletAddress: "invalid" }]) assert.equal(configSchema.safeParse(invalid).success, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerodrome-demo-"));
  let step = 0;
  const server = createAeroMcpServer({ walletOverview: async input => getWalletOverview(input, overviewFixture().runtime), protocolStatus: async () => ({}), votingPosition: async () => ({}), walletRewards: async () => ({}), walletChanges: async (_signal, input) => getWalletChanges({ cfg, client: {} }, dir, async () => snapshot(step++), input) });
  const client = new Client({ name: "offline-demo", version: "0.1.0" });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const overview = await client.callTool({ name: "aerodrome_wallet_overview", arguments: { wallet: address(2), gauges: [address(4)] } });
    assert.equal(overview.isError, undefined);
    console.log(JSON.stringify({ source: "SYNTHETIC - address-only overview, no RPC", summary: walletOverviewSchema.parse(overview.structuredContent).summary }, null, 2));
    for (let run = 0; run < 2; run++) {
      const response = await client.callTool({ name: "aerodrome_wallet_changes", arguments: { requestId: randomUUID() } });
      assert.equal(response.isError, undefined);
      const result = walletChangesSchema.parse(response.structuredContent);
      assert.equal(result.status, run ? "COMPARED" : "BASELINE_CREATED");
      if (run) { assert.equal(result.changes.length, 1); assert.equal(result.changes[0].deltaRaw, "25"); }
      console.log(JSON.stringify({ source: "SYNTHETIC — no real wallet or RPC", status: result.status, changes: result.changes, findings: result.findings, baselineSaved: result.baselineSaved }, null, 2));
    }
  } finally { await client.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(() => { console.error("Offline demo failed"); process.exitCode = 1; });
