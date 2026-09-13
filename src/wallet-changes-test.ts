import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAeroMcpServer } from "./mcp/server.js";
import type { AppConfig } from "./types.js";
import { walletSnapshotSchema } from "./mcp/schema.js";
import { compareWalletSnapshots, getWalletChanges, getWalletReport, walletChangesSchema } from "./mcp/changes.js";

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
  const transferred = structuredClone(partial);
  transferred.voting.positions[0].owner = "0x0000000000000000000000000000000000000099";
  transferred.rewards.excludedTokenIds = [{ tokenId: "1", owner: transferred.voting.positions[0].owner, reason: "NOT_OWNED" }];
  const ownershipDelta = compareWalletSnapshots(baseline, transferred);
  assert.equal(ownershipDelta.changes.find(x => x.key === "veNFT:1/owner")?.after, transferred.voting.positions[0].owner);
  assert.equal(ownershipDelta.changes.some(x => x.section === "rewards"), false);
  const formatting = structuredClone(baseline);
  formatting.rewards.configuredTokenIds = ["01"];
  formatting.voting.positions[0].tokenId = "01";
  for (const row of formatting.rewards.votingRewards) row.tokenId = "01";
  for (const key of Object.keys(formatting.protocol.contracts) as (keyof typeof formatting.protocol.contracts)[]) formatting.protocol.contracts[key] = formatting.protocol.contracts[key].toLowerCase();
  assert.deepEqual(compareWalletSnapshots(baseline, formatting).changes, []);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aero-changes-"));
  const runtime = { cfg, client: {} };
  const capture = (snapshot: unknown, requestId = randomUUID(), dir = directory) => getWalletChanges(runtime, dir, async () => snapshot, { requestId });
  const noRPC = async () => { throw new Error("Replay must not read RPC"); };
  try {
    const firstId = randomUUID();
    const first = await capture(baseline, firstId);
    assert.equal(first.status, "BASELINE_CREATED");
    assert.equal(first.baselineSaved, true);
    assert.equal(first.reportSaved, true);
    assert.equal(first.reportId, firstId);
    const file = path.join(directory, fs.readdirSync(directory).find(x => x.endsWith(".json"))!);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const originalBaseline = JSON.parse(fs.readFileSync(file, "utf8")).snapshot;
    const partialId = randomUUID();
    const partialReport = await capture(transferred, partialId);
    assert.equal(partialReport.baselineSaved, false);
    assert.equal(partialReport.reportSaved, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).snapshot, originalBaseline);
    assert.deepEqual(await getWalletReport({ reportId: partialId }, runtime, directory), partialReport);
    const secondId = randomUUID();
    const second = await capture(current, secondId);
    assert.equal(second.status, "COMPARED");
    assert.equal(second.previousObservation?.blockNumber, "123");
    assert.equal(second.baselineSaved, true);
    // Simulate lost response: retry a known request ID, with an unusable provider.
    assert.deepEqual(await getWalletChanges(runtime, directory, noRPC, { requestId: secondId }), second);
    assert.deepEqual(await getWalletChanges(runtime, directory, noRPC, { requestId: secondId.toUpperCase() }), second);
    const aliasCfg = { ...cfg, veNftTokenIds: ["01"], gaugeAddresses: [...cfg.gaugeAddresses, ...cfg.gaugeAddresses].map(x => x.toLowerCase()), contracts: Object.fromEntries(Object.entries(cfg.contracts).reverse().map(([key, value]) => [key, value.toLowerCase()])) as typeof cfg.contracts };
    assert.deepEqual(await getWalletChanges({ cfg: aliasCfg, client: {} }, directory, noRPC, { requestId: secondId }), second);
    const saved = fs.readFileSync(file, "utf8");
    await assert.rejects(capture(baseline), /older/);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    const controller = new AbortController();
    await assert.rejects(getWalletChanges({ ...runtime, signal: controller.signal }, directory, async () => { controller.abort(); return current; }, { requestId: randomUUID() }));
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    // Force failure just before rename: neither baseline nor report can be committed alone.
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error("injected commit failure"); };
    try { await assert.rejects(capture(current), /injected/); } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    assert.equal(fs.readdirSync(directory).length, 1);
    const lock = file.replace(/\.json$/, ".lock");
    fs.writeFileSync(lock, "");
    await assert.rejects(capture(current), /HISTORY_BUSY/);
    assert.deepEqual(await getWalletReport({ reportId: secondId }, runtime, directory), second);
    assert.deepEqual(await getWalletChanges(runtime, directory, noRPC, { requestId: secondId }), second);
    fs.unlinkSync(lock);
    await assert.rejects(getWalletReport({ reportId: randomUUID() }, runtime, directory), /REPORT_NOT_FOUND/);
    await testProcesses(directory, cfg, current, secondId);
    // A finite archive refuses new captures instead of evicting retry identities.
    const history = JSON.parse(fs.readFileSync(file, "utf8"));
    const beforeFull = JSON.stringify(history);
    history.reports = Array.from({ length: 100 }, () => ({ ...second, reportId: randomUUID() }));
    fs.writeFileSync(file, JSON.stringify(history));
    await assert.rejects(getWalletChanges(runtime, directory, noRPC, { requestId: randomUUID() }), /HISTORY_FULL/);
    assert.deepEqual(await getWalletReport({ reportId: history.reports[0].reportId }, runtime, directory), history.reports[0]);
    fs.writeFileSync(file, beforeFull);
    fs.writeFileSync(file, "invalid");
    await assert.rejects(capture(current));
    assert.equal(fs.readFileSync(file, "utf8"), "invalid");
    fs.writeFileSync(file, saved);
    // Migrate a real v1 layout even when the caller changes spelling/order.
    const legacyDir = path.join(directory, "legacy");
    fs.mkdirSync(legacyDir);
    const oldScope = JSON.stringify({ version: 1, wallet: cfg.walletAddress.toLowerCase(), ids: ["01"], gauges: cfg.gaugeAddresses.map(x => x.toLowerCase()).sort(), contracts: cfg.contracts, includeZero: true, maxItems: 200 });
    const legacyPath = path.join(legacyDir, `${createHash("sha256").update(oldScope).digest("hex")}.json`);
    const legacyBody = JSON.stringify({ version: 1, scope: oldScope, snapshot: baseline });
    fs.writeFileSync(legacyPath, legacyBody);
    const migratedId = randomUUID();
    const migrated = await capture(current, migratedId, legacyDir);
    assert.equal(migrated.status, "COMPARED");
    assert.equal(migrated.previousObservation?.blockNumber, "123");
    assert.equal(fs.readFileSync(legacyPath, "utf8"), legacyBody);
    assert.deepEqual(await getWalletChanges({ cfg: aliasCfg, client: {} }, legacyDir, noRPC, { requestId: migratedId }), migrated);
    const mcpDirectory = path.join(directory, "mcp");
    let calls = 0;
    const server = createAeroMcpServer({
      protocolStatus: async () => ({}), votingPosition: async () => ({}), walletRewards: async () => ({}),
      walletChanges: async (signal, input) => getWalletChanges({ ...runtime, signal }, mcpDirectory, async () => calls++ === 0 ? baseline : current, input),
      walletReport: async input => getWalletReport(input, runtime, mcpDirectory)
    });
    const client = new Client({ name: "changes-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    try {
      const first = await client.callTool({ name: "aerodrome_wallet_changes", arguments: { requestId: randomUUID() } });
      assert.equal(first.isError, undefined);
      assert.equal(walletChangesSchema.parse(first.structuredContent).status, "BASELINE_CREATED");
      const requestId = randomUUID();
      const second = await client.callTool({ name: "aerodrome_wallet_changes", arguments: { requestId } });
      assert.equal(second.isError, undefined);
      assert.equal(walletChangesSchema.parse(second.structuredContent).status, "COMPARED");
      const replay = await client.callTool({ name: "aerodrome_wallet_changes", arguments: { requestId } });
      assert.deepEqual(replay.structuredContent, second.structuredContent);
      const read = await client.callTool({ name: "aerodrome_wallet_report", arguments: { reportId: requestId } });
      assert.deepEqual(read.structuredContent, second.structuredContent);
      assert.equal(calls, 2);
      const missing = await client.callTool({ name: "aerodrome_wallet_report", arguments: { reportId: randomUUID() } });
      assert.equal(missing.isError, true);
      assert.match(JSON.stringify(missing.content), /REPORT_NOT_FOUND/);
      const invalid = await client.callTool({ name: "aerodrome_wallet_changes", arguments: {} });
      assert.equal(invalid.isError, true);
      assert.equal(calls, 2);
    } finally { await client.close(); await server.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function testProcesses(directory: string, cfg: AppConfig, current: unknown, existingId: string) {
  const helper = fileURLToPath(new URL("./history-process-test.ts", import.meta.url));
  const fixture = path.join(directory, "process-fixture.json");
  const advanced = walletSnapshotSchema.parse(current);
  for (const section of [advanced, advanced.protocol, advanced.voting, advanced.rewards]) section.observation.blockNumber = "125";
  advanced.rewards.votingRewards[0].amountRaw = "8";
  fs.writeFileSync(fixture, JSON.stringify({ cfg, current: advanced }));
  const args = (mode: string, id: string) => ["--import", "tsx", helper, mode, directory, fixture, id];
  const requestId = randomUUID();
  // Fresh process commits but deliberately never delivers its report.
  const lost = spawnSync(process.execPath, args("lost", requestId), { encoding: "utf8" });
  assert.equal(lost.status, 0, lost.stderr);
  const restarted = spawnSync(process.execPath, args("replay", requestId), { encoding: "utf8" });
  assert.equal(restarted.status, 0, restarted.stderr);
  const restored = walletChangesSchema.parse(JSON.parse(restarted.stdout));
  assert.equal(restored.reportId, requestId);
  assert.equal(restored.changes.find(change => change.section === "rewards")?.deltaRaw, "6");
  const heldId = randomUUID();
  const child = spawn(process.execPath, args("hold", heldId), { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise<number | null>(resolve => child.on("close", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Child failed to acquire lock")), 10_000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
    });
    // Second process cannot silently consume the same comparison while first is reading.
    const contender = spawnSync(process.execPath, args("busy", heldId), { encoding: "utf8" });
    assert.equal(contender.status, 0, contender.stderr);
    const readable = spawnSync(process.execPath, args("replay", existingId), { encoding: "utf8" });
    assert.equal(readable.status, 0, readable.stderr);
    child.kill("SIGKILL");
    await closed;
    const lock = fs.readdirSync(directory).find(name => name.endsWith(".lock"))!;
    assert.ok(lock);
    // Committed reports survive a crashed writer; never guess that a stale lock is safe.
    const afterCrash = spawnSync(process.execPath, args("replay", existingId), { encoding: "utf8" });
    assert.equal(afterCrash.status, 0, afterCrash.stderr);
    fs.unlinkSync(path.join(directory, lock)); // child death is verified above
    const retry = spawnSync(process.execPath, args("lost", heldId), { encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stderr);
  } finally {
    child.kill("SIGKILL");
    await closed;
    fs.rmSync(fixture, { force: true });
  }
}
