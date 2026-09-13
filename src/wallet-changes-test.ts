import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAeroMcpServer } from "./mcp/server.js";
import type { AppConfig } from "./types.js";
import { walletSnapshotSchema } from "./mcp/schema.js";
import { compareWalletSnapshots, getWalletChanges, walletChangesSchema } from "./mcp/changes.js";

export async function testWalletChanges(value: unknown, cfg: AppConfig) {
  const baseline = walletSnapshotSchema.parse(value);
  const current = structuredClone(baseline);
  for (const section of [current, current.protocol, current.voting, current.rewards]) section.observation.blockNumber = "124";
  current.voting.positions[0].currentVotingPowerRaw = "9007199254740993999";
  current.rewards.votingRewards[0].amountRaw = "2";
  const delta = compareWalletSnapshots(baseline, current);
  assert.equal(delta.status, "COMPARED");
  assert.equal(delta.changes.find(x => x.key.endsWith("currentVotingPowerRaw"))?.deltaRaw, (9007199254740993999n - BigInt(baseline.voting.positions[0].currentVotingPowerRaw)).toString());
  assert.equal(delta.changes.find(x => x.section === "rewards")?.deltaRaw, "-3");
  assert.equal(compareWalletSnapshots(baseline, baseline).changes.length, 0);
  const absent = structuredClone(current);
  absent.rewards.votingRewards = [];
  const disappearance = compareWalletSnapshots(baseline, absent).changes.find(x => x.section === "rewards");
  assert.equal(disappearance?.kind, "NO_LONGER_OBSERVED");
  assert.equal(disappearance?.deltaRaw, null);
  const partial = structuredClone(current);
  partial.status = "PARTIAL_BOUNDED_SCOPE";
  partial.rewards.status = "PARTIAL_BOUNDED_SCOPE";
  const partialDelta = compareWalletSnapshots(baseline, partial);
  assert.equal(partialDelta.changes.some(x => x.section === "rewards"), false);
  assert.deepEqual(partialDelta.unavailableSections, ["rewards"]);
  const other = structuredClone(current);
  other.rewards.wallet = "0x0000000000000000000000000000000000000099";
  assert.throws(() => compareWalletSnapshots(baseline, other), /identity/);
  assert.throws(() => compareWalletSnapshots(current, baseline), /older/);
  const reorg = structuredClone(baseline);
  for (const section of [reorg, reorg.protocol, reorg.voting, reorg.rewards]) section.observation.blockHash = `0x${"cd".repeat(32)}`;
  assert.throws(() => compareWalletSnapshots(baseline, reorg), /hash/);
  const newEpoch = structuredClone(current);
  newEpoch.protocol.epoch.start = "1970-01-01T00:30:00.000Z";
  assert.equal(compareWalletSnapshots(baseline, newEpoch).epochChanged, true);
  assert.equal(compareWalletSnapshots(null, partial).status, "PARTIAL");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aero-changes-"));
  const runtime = { cfg, client: {} };
  try {
    const first = await getWalletChanges(runtime, directory, async () => baseline);
    assert.equal(first.status, "BASELINE_CREATED");
    assert.equal(first.baselineSaved, true);
    const file = path.join(directory, fs.readdirSync(directory).find(x => x.endsWith(".json"))!);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const original = fs.readFileSync(file, "utf8");
    assert.equal((await getWalletChanges(runtime, directory, async () => partial)).baselineSaved, false);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    const second = await getWalletChanges(runtime, directory, async () => current);
    assert.equal(second.status, "COMPARED");
    assert.equal(second.previousObservation?.blockNumber, "123");
    assert.equal(second.baselineSaved, true);
    const saved = fs.readFileSync(file, "utf8");
    await assert.rejects(getWalletChanges(runtime, directory, async () => baseline), /older/);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    const lock = file.replace(/\.json$/, ".lock");
    fs.writeFileSync(lock, "");
    await assert.rejects(getWalletChanges(runtime, directory, async () => current));
    fs.unlinkSync(lock);
    fs.writeFileSync(file, "invalid");
    await assert.rejects(getWalletChanges(runtime, directory, async () => current));
    assert.equal(fs.readFileSync(file, "utf8"), "invalid");
    assert.equal(fs.readdirSync(directory).length, 1);
    const mcpDirectory = path.join(directory, "mcp");
    let calls = 0;
    const server = createAeroMcpServer({
      protocolStatus: async () => ({}), votingPosition: async () => ({}), walletRewards: async () => ({}),
      walletChanges: async () => getWalletChanges(runtime, mcpDirectory, async () => calls++ === 0 ? baseline : current)
    });
    const client = new Client({ name: "changes-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      const first = await client.callTool({ name: "aerodrome_wallet_changes", arguments: {} });
      assert.equal(first.isError, undefined);
      assert.equal(walletChangesSchema.parse(first.structuredContent).status, "BASELINE_CREATED");
      const second = await client.callTool({ name: "aerodrome_wallet_changes", arguments: {} });
      assert.equal(second.isError, undefined);
      assert.equal(walletChangesSchema.parse(second.structuredContent).status, "COMPARED");
    } finally { await client.close(); await server.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
