import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { overviewFixture, fixtureAddress } from "./overview-fixture.js";
import { getWalletOverview, walletOverviewSchema } from "./mcp/overview.js";
import { getProtocolStatus, getWalletRewards } from "./mcp/data.js";
import { createAeroMcpServer } from "./mcp/server.js";
import { configSchema } from "./config.js";

export async function testWalletOverview() {
  assert.deepEqual(configSchema.parse({}), { veNftTokenIds: [], gaugeAddresses: [] });
  const fixture = overviewFixture();
  const overview = await getWalletOverview({ wallet: fixture.wallet, gauges: [fixture.gauge] }, fixture.runtime);
  assert.equal(overview.status, "VERIFIED_BOUNDED_SCOPE");
  assert.deepEqual(overview.discovery.tokenIds, ["1"]);
  assert.equal(overview.locks[0].principalFormatted, "40");
  assert.equal(overview.voting?.positions[0].currentVotingPowerRaw, "20000000000000000000");
  assert.equal(overview.liquidBalances[0].amountFormatted, "1.25");
  assert.equal(overview.liquidBalances.find(row => row.symbol === "USDC")?.amountFormatted, "12.5");
  assert.equal(overview.rewards?.gaugeRewards[0].amountFormatted, "2.5");
  assert.ok(overview.summaryRu.some(line => line.includes("сила голоса 20")));
  assert.ok(overview.summaryRu.some(line => line.includes("Награда") && line.includes("2.5")));
  assert.ok(fixture.calls.includes("ownerToNFTokenIdList"));
  assert.equal("netWorth" in overview, false);
  const empty = overviewFixture("empty");
  const emptyResult = await getWalletOverview({ wallet: empty.wallet }, empty.runtime);
  assert.equal(emptyResult.status, "VERIFIED_BOUNDED_SCOPE");
  assert.equal(emptyResult.discovery.ownedCount, "0");
  assert.deepEqual(emptyResult.voting?.positions, []);
  assert.deepEqual(emptyResult.rewards?.configuredTokenIds, []);
  const publicResult = await getProtocolStatus(overviewFixture().runtime);
  assert.equal(publicResult.chainId, 8453);
  await assert.rejects(getWalletOverview({}, overviewFixture().runtime), /WALLET_REQUIRED/);
  await assert.rejects(getWalletRewards({}, overviewFixture().runtime), /WALLET_REQUIRED/);
  for (const mode of ["many", "managed", "discoveryFail", "metadataFail", "nativeFail", "ownerMismatch", "votingFail", "rewardsFail", "duplicate"]) {
    const test = overviewFixture(mode);
    const result = await getWalletOverview({ wallet: test.wallet, gauges: [test.gauge] }, test.runtime);
    assert.equal(result.status, "PARTIAL_BOUNDED_SCOPE", mode);
    if (mode === "many") { assert.equal(result.discovery.tokenIds.length, 16); assert.equal(result.discovery.ownedCount, "17"); }
    if (mode === "managed") { assert.equal(result.locks[0].principalRaw, null); assert.equal(result.locks[0].status, "UNSUPPORTED_MANAGED"); }
    if (mode === "discoveryFail") { assert.equal(result.discovery.ownedCount, null); assert.equal(result.rewards?.status, "PARTIAL_BOUNDED_SCOPE"); }
    if (mode === "metadataFail") { const row = result.liquidBalances.find(row => row.token === test.token)!; assert.equal(row.amountFormatted, null); assert.equal(row.amountRaw, "3000000000000000000"); }
    if (mode === "nativeFail") assert.equal(result.liquidBalances[0].amountRaw, null);
    if (mode === "ownerMismatch" || mode === "duplicate") assert.deepEqual(result.discovery.tokenIds, []);
    if (mode === "votingFail") { assert.equal(result.voting, null); assert.equal(result.locks[0].principalFormatted, "40"); assert.equal(result.rewards?.gaugeRewards.length, 1); }
    if (mode === "rewardsFail") { assert.equal(result.rewards?.status, "PARTIAL_BOUNDED_SCOPE"); assert.deepEqual(result.rewards?.gaugeRewards, []); assert.equal(result.liquidBalances[0].amountFormatted, "1.25"); }
  }
  for (const mode of ["wrongChain", "reorg", "cancel"]) {
    const test = overviewFixture(mode);
    await assert.rejects(getWalletOverview({ wallet: test.wallet }, test.runtime));
  }
  const other = overviewFixture("empty");
  other.runtime.cfg.walletAddress = fixtureAddress(99);
  other.runtime.cfg.gaugeAddresses = [other.gauge];
  const noLeak = await getWalletOverview({ wallet: other.wallet }, other.runtime);
  assert.deepEqual(noLeak.rewards?.gaugeRewards, []);
  const invalid = overviewFixture();
  await assert.rejects(getWalletOverview({ wallet: "bad" }, invalid.runtime));
  await assert.rejects(getWalletOverview({ wallet: invalid.wallet, tokens: [invalid.token, invalid.token] }, invalid.runtime));
  assert.equal(invalid.calls.length, 0);
  const server = createAeroMcpServer({
    protocolStatus: async () => ({}), votingPosition: async () => ({}), walletRewards: async () => ({}),
    walletOverview: async (input, signal) => getWalletOverview(input, { ...overviewFixture().runtime, signal })
  });
  const client = new Client({ name: "overview-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const result = await client.callTool({ name: "aerodrome_wallet_overview", arguments: { wallet: fixture.wallet } });
    assert.equal(result.isError, undefined);
    walletOverviewSchema.parse(result.structuredContent);
    const missing = await client.callTool({ name: "aerodrome_wallet_overview", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /WALLET_REQUIRED/);
  } finally { await client.close(); await server.close(); }
}
