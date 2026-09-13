import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { createDefaultRuntime, getWalletSnapshot, type ToolRuntime } from "./data.js";
import { walletSnapshotSchema } from "./schema.js";

type Snapshot = z.infer<typeof walletSnapshotSchema>;
const scalar = z.union([z.string(), z.boolean(), z.null()]);
export const walletChangesSchema = z.strictObject({
  status: z.enum(["BASELINE_CREATED", "COMPARED", "PARTIAL"]),
  chainId: z.literal(8453), blockchainReadOnly: z.literal(true),
  observation: walletSnapshotSchema.shape.observation,
  previousObservation: walletSnapshotSchema.shape.observation.nullable(),
  baselineSaved: z.boolean(), epochChanged: z.boolean().nullable(),
  changes: z.array(z.strictObject({
    section: z.enum(["protocol", "voting", "rewards"]), key: z.string(),
    kind: z.enum(["CHANGED", "APPEARED", "NO_LONGER_OBSERVED"]),
    before: scalar, after: scalar, deltaRaw: z.string().regex(/^-?\d+$/).nullable()
  })),
  unavailableSections: z.array(z.enum(["voting", "rewards"])),
  warnings: z.array(z.string())
});
const storedSchema = z.strictObject({ version: z.literal(1), scope: z.string(), snapshot: walletSnapshotSchema });
const DEFAULT_STORE = fileURLToPath(new URL("../../.snapshot-history/", import.meta.url));

function validateSnapshot(value: unknown): Snapshot {
  const snapshot = walletSnapshotSchema.parse(value);
  for (const section of [snapshot.protocol, snapshot.voting, snapshot.rewards]) {
    if (JSON.stringify(section.observation) !== JSON.stringify(snapshot.observation)) throw new Error("Inconsistent snapshot observations.");
  }
  return snapshot;
}
function complete(snapshot: Snapshot) {
  return snapshot.status === "VERIFIED_BOUNDED_SCOPE" && snapshot.voting.status === "VERIFIED_POINT_IN_TIME" && snapshot.rewards.status === "VERIFIED_BOUNDED_SCOPE";
}
function fields(snapshot: Snapshot, section: "protocol" | "voting" | "rewards") {
  const result = new Map<string, string | boolean | null>();
  const add = (key: string, value: string | boolean | null) => {
    if (result.has(key)) throw new Error("Duplicate snapshot evidence.");
    result.set(key, value);
  };
  if (section === "protocol") {
    for (const [key, value] of Object.entries(snapshot.protocol.protocol)) add(key, value);
    add("normalVotingOpen", snapshot.protocol.epoch.normalVotingOpen);
  }
  if (section === "voting") for (const position of snapshot.voting.positions) {
    const prefix = `veNFT:${position.tokenId}`;
    for (const key of ["owner", "currentVotingPowerRaw", "usedWeightRaw", "lastVotedAt", "votedThisEpoch"] as const) add(`${prefix}/${key}`, position[key]);
    for (const pool of position.pools) {
      for (const key of ["gauge", "gaugeAlive", "voteWeightRaw", "poolWeightRaw"] as const) add(`${prefix}/pool:${pool.pool.toLowerCase()}/${key}`, pool[key]);
    }
  }
  if (section === "rewards") {
    for (const row of snapshot.rewards.votingRewards) add(`veNFT:${row.tokenId}/pool:${row.pool.toLowerCase()}/${row.type}:${row.rewardContract.toLowerCase()}/token:${row.token.toLowerCase()}/amountRaw`, row.amountRaw);
    for (const row of snapshot.rewards.gaugeRewards) add(`gauge:${row.gauge.toLowerCase()}/token:${row.token.toLowerCase()}/amountRaw`, row.amountRaw);
  }
  return result;
}

export function compareWalletSnapshots(previous: Snapshot | null, current: Snapshot) {
  current = validateSnapshot(current);
  if (previous) {
    previous = validateSnapshot(previous);
    if (!complete(previous)) throw new Error("Baseline must be complete within its scope.");
    if (previous.rewards.wallet.toLowerCase() !== current.rewards.wallet.toLowerCase() ||
        JSON.stringify(previous.rewards.configuredTokenIds.slice().sort()) !== JSON.stringify(current.rewards.configuredTokenIds.slice().sort()) ||
        JSON.stringify(previous.protocol.contracts) !== JSON.stringify(current.protocol.contracts)) throw new Error("Snapshot identity changed.");
    if (BigInt(current.observation.blockNumber) < BigInt(previous.observation.blockNumber)) throw new Error("Snapshot is older than baseline.");
    if (current.observation.blockNumber === previous.observation.blockNumber && current.observation.blockHash !== previous.observation.blockHash) throw new Error("Baseline block hash changed.");
  }
  const unavailableSections: ("voting" | "rewards")[] = [];
  if (current.voting.status !== "VERIFIED_POINT_IN_TIME") unavailableSections.push("voting");
  if (current.rewards.status !== "VERIFIED_BOUNDED_SCOPE") unavailableSections.push("rewards");
  const changes: z.infer<typeof walletChangesSchema>["changes"] = [];
  for (const section of ["protocol", "voting", "rewards"] as const) {
    const after = fields(current, section);
    if (!previous || unavailableSections.includes(section as "voting" | "rewards")) continue;
    const before = fields(previous, section);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key) ?? null;
      const b = after.get(key) ?? null;
      if (before.has(key) === after.has(key) && a === b) continue;
      changes.push({ section, key,
        kind: !before.has(key) ? "APPEARED" : !after.has(key) ? "NO_LONGER_OBSERVED" : "CHANGED",
        before: a, after: b,
        deltaRaw: /Raw$|poolCount$|maxPoolsPerVote$/.test(key) && typeof a === "string" && /^\d+$/.test(a) && typeof b === "string" && /^\d+$/.test(b) ? (BigInt(b) - BigInt(a)).toString() : null
      });
    }
  }
  return walletChangesSchema.parse({
    status: !complete(current) ? "PARTIAL" : previous ? "COMPARED" : "BASELINE_CREATED",
    chainId: 8453, blockchainReadOnly: true, observation: current.observation,
    previousObservation: previous?.observation ?? null, baselineSaved: false,
    epochChanged: previous ? previous.protocol.epoch.start !== current.protocol.epoch.start : null,
    changes, unavailableSections,
    warnings: [...current.warnings,
      "Only observed current-scope values are compared. Missing rows are unknown, not zero. A reward decrease does not prove a claim or income.",
      ...(!complete(current) ? ["Partial snapshot did not replace the last complete baseline; unavailable sections were not compared."] : [])]
  });
}

/** One atomic private baseline per configured scope; no scheduler or model calls. */
export async function getWalletChanges(
  runtime: ToolRuntime = createDefaultRuntime(),
  directory = DEFAULT_STORE,
  readSnapshot: () => Promise<unknown> = () => getWalletSnapshot({ includeZero: true, maxItems: 200 }, runtime)
) {
  const scope = JSON.stringify({ version: 1, wallet: runtime.cfg.walletAddress.toLowerCase(),
    ids: runtime.cfg.veNftTokenIds.map(String).sort(), gauges: runtime.cfg.gaugeAddresses.map(x => x.toLowerCase()).sort(),
    contracts: runtime.cfg.contracts, includeZero: true, maxItems: 200 });
  const key = createHash("sha256").update(scope).digest("hex");
  const current = validateSnapshot(await readSnapshot());
  runtime.signal?.throwIfAborted();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${key}.json`);
  const lock = path.join(directory, `${key}.lock`);
  // Exclusive lock also protects multiple MCP processes. Existing locks fail closed.
  const fd = fs.openSync(lock, "wx", 0o600);
  const temp = path.join(directory, `${key}.${randomUUID()}.tmp`);
  try {
    let previous: Snapshot | null = null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) throw new Error("Invalid baseline file.");
      const stored = storedSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (stored.scope !== scope) throw new Error("Baseline scope mismatch.");
      previous = stored.snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = compareWalletSnapshots(previous, current);
    runtime.signal?.throwIfAborted();
    if (complete(current)) {
      const body = JSON.stringify({ version: 1, scope, snapshot: current });
      if (Buffer.byteLength(body) > 4_000_000) throw new Error("Snapshot exceeds storage limit.");
      fs.writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file);
      result.baselineSaved = true;
    }
    return result;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.unlinkSync(lock);
  }
}
