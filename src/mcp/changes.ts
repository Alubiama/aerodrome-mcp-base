import { walletAddress } from "../config.js";
import { explainChanges, findingSchema, renderLegacyFinding } from "./findings.js";
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
  reportId: z.uuid().nullable(), reportSaved: z.boolean(),
  baselineSaved: z.boolean(), epochChanged: z.boolean().nullable(),
  changes: z.array(z.strictObject({
    section: z.enum(["protocol", "voting", "rewards"]), key: z.string(),
    kind: z.enum(["CHANGED", "APPEARED", "NO_LONGER_OBSERVED"]),
    before: scalar, after: scalar, deltaRaw: z.string().regex(/^-?\d+$/).nullable()
  })),
  findings: z.array(findingSchema).default([]),
  unavailableSections: z.array(z.enum(["voting", "rewards"])),
  warnings: z.array(z.string())
});
const storedSchema = z.strictObject({ version: z.literal(1), scope: z.string(), snapshot: walletSnapshotSchema });
const DEFAULT_STORE = fileURLToPath(new URL("../../.snapshot-history/", import.meta.url));

const ids = (values: string[]) => [...new Set(values.map(value => BigInt(value).toString()))].sort();
const addresses = (values: string[]) => [...new Set(values.map(value => value.toLowerCase()))].sort();
const contracts = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.toLowerCase()]));

function validateSnapshot(value: unknown): Snapshot {
  const snapshot = walletSnapshotSchema.parse(value);
  for (const section of [snapshot.protocol, snapshot.voting, snapshot.rewards]) {
    if (JSON.stringify(section.observation) !== JSON.stringify(snapshot.observation)) throw new Error("Inconsistent snapshot observations.");
  }
  snapshot.rewards.configuredTokenIds = ids(snapshot.rewards.configuredTokenIds);
  snapshot.rewards.wallet = snapshot.rewards.wallet.toLowerCase();
  for (const key of Object.keys(snapshot.protocol.contracts) as (keyof Snapshot["protocol"]["contracts"])[]) snapshot.protocol.contracts[key] = snapshot.protocol.contracts[key].toLowerCase();
  for (const position of snapshot.voting.positions) {
    position.tokenId = BigInt(position.tokenId).toString();
    position.owner = position.owner.toLowerCase();
    for (const pool of position.pools) { pool.pool = pool.pool.toLowerCase(); pool.gauge = pool.gauge.toLowerCase(); }
  }
  for (const row of snapshot.rewards.votingRewards) row.tokenId = BigInt(row.tokenId).toString();
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
    previousObservation: previous?.observation ?? null, reportId: null, reportSaved: false, baselineSaved: false,
    epochChanged: previous ? previous.protocol.epoch.start !== current.protocol.epoch.start : null,
    changes, unavailableSections, findings: explainChanges(previous, current, changes, unavailableSections),
    warnings: [...current.warnings,
      "Only observed current-scope values are compared. Missing rows are unknown, not zero. A reward decrease does not prove a claim or income.",
      ...(!complete(current) ? ["Partial snapshot did not replace the last complete baseline; unavailable sections were not compared."] : [])]
  });
}

export const walletChangesInputSchema = z.strictObject({
  requestId: z.uuid().transform(value => value.toLowerCase()).describe("Generate one UUID before capture. Reuse it on every retry; use a new UUID only for a new comparison.")
});
export const walletReportInputSchema = z.strictObject({ reportId: z.uuid().transform(value => value.toLowerCase()) });
export type WalletChangesInput = z.infer<typeof walletChangesInputSchema>;
export type WalletReportInput = z.infer<typeof walletReportInputSchema>;
const storedReportSchema = z.union([
  walletChangesSchema,
  walletChangesSchema.extend({ findings: z.array(findingSchema.omit({ message: true }).extend({ messageRu: z.string() })) })
]).transform(report => ({ ...report, findings: report.findings.map(finding => {
  if ("message" in finding) return finding;
  const { messageRu: _legacyText, ...evidence } = finding;
  return { ...evidence, message: renderLegacyFinding(evidence, report.changes.find(change => change.key === evidence.key)) };
}) }));
const historySchema = z.strictObject({
  version: z.literal(2), scope: z.string(), snapshot: walletSnapshotSchema.nullable(),
  reports: z.array(storedReportSchema).max(100)
});
type History = z.infer<typeof historySchema>;
const MAX_BYTES = 32_000_000;
export class HistoryError extends Error {
  constructor(public code: "HISTORY_BUSY" | "REPORT_NOT_FOUND" | "HISTORY_FULL") { super(code); }
}
function scopeFor(runtime: ToolRuntime) {
  return canonicalScope({ wallet: walletAddress(runtime.cfg), ids: runtime.cfg.veNftTokenIds,
    gauges: runtime.cfg.gaugeAddresses, contracts: runtime.cfg.contracts });
}
function canonicalScope(value: { wallet: string; ids: string[]; gauges: string[]; contracts: Record<string, string> }) {
  return JSON.stringify({ version: 1, wallet: value.wallet.toLowerCase(), ids: ids(value.ids),
    gauges: addresses(value.gauges), contracts: contracts(value.contracts), includeZero: true, maxItems: 200 });
}
function historyPath(directory: string, scope: string) {
  return path.join(directory, `${createHash("sha256").update(scope).digest("hex")}.json`);
}
function readFile(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid history file.");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
function readHistory(directory: string, scope: string): History {
  const file = historyPath(directory, scope);
  try {
    const value = readFile(file) as { version?: number };
    if (value.version === 2) {
      const history = historySchema.parse(value);
      if (history.scope !== scope || new Set(history.reports.map(r => r.reportId)).size !== history.reports.length ||
          history.reports.some(r => !r.reportSaved || !r.reportId)) throw new Error("Invalid report history.");
      if (history.snapshot && !complete(validateSnapshot(history.snapshot))) throw new Error("Invalid baseline.");
      return history;
    }
    if (value.version !== 1) throw new Error("Unsupported history version.");
    // Version 1 is handled together with equivalent noncanonical scope files below.
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let names: string[];
  try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") names = []; else throw error; }
  if (names.length > 2000) throw new Error("Too many history scopes.");
  const matches: Snapshot[] = [];
  for (const name of names) {
    const value = readFile(path.join(directory, name)) as { version?: number; scope?: string };
    if (value.version !== 1) continue;
    const stored = storedSchema.parse(value);
    const oldScope = JSON.parse(stored.scope);
    if (oldScope.version !== 1 || oldScope.includeZero !== true || oldScope.maxItems !== 200) throw new Error("Invalid legacy scope.");
    if (canonicalScope(oldScope) === scope) matches.push(validateSnapshot(stored.snapshot));
  }
  // Never guess between histories previously split by token/address formatting.
  if (matches.length > 1) throw new Error("Multiple equivalent legacy baselines; reconcile before capture.");
  if (matches[0] && !complete(matches[0])) throw new Error("Invalid legacy baseline.");
  return { version: 2, scope, snapshot: matches[0] ?? null, reports: [] };
}

/** Read an immutable committed report without RPC, locks or baseline mutation. */
export async function getWalletReport(input: WalletReportInput, runtime: ToolRuntime = createDefaultRuntime(), directory = DEFAULT_STORE) {
  const { reportId } = walletReportInputSchema.parse(input);
  runtime.signal?.throwIfAborted();
  const report = readHistory(directory, scopeFor(runtime)).reports.find(report => report.reportId === reportId);
  if (!report) throw new HistoryError("REPORT_NOT_FOUND");
  return report;
}

/** Commit report and baseline in one rename. The client owns the retry ID before any RPC. */
export async function getWalletChanges(
  runtime: ToolRuntime,
  directory = DEFAULT_STORE,
  readSnapshot: () => Promise<unknown> = () => getWalletSnapshot({ includeZero: true, maxItems: 200 }, runtime),
  input: WalletChangesInput
) {
  const { requestId } = walletChangesInputSchema.parse(input);
  const scope = scopeFor(runtime);
  runtime.signal?.throwIfAborted();
  const replay = readHistory(directory, scope).reports.find(report => report.reportId === requestId);
  if (replay) return replay;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = historyPath(directory, scope);
  const lock = file.replace(/\.json$/, ".lock");
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HistoryError("HISTORY_BUSY");
    throw error;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const history = readHistory(directory, scope);
    const replay = history.reports.find(report => report.reportId === requestId);
    if (replay) return replay;
    if (history.reports.length >= 100) throw new HistoryError("HISTORY_FULL");
    const current = validateSnapshot(await readSnapshot());
    runtime.signal?.throwIfAborted();
    if (current.rewards.wallet !== walletAddress(runtime.cfg).toLowerCase() ||
        JSON.stringify(ids(current.rewards.configuredTokenIds)) !== JSON.stringify(ids(runtime.cfg.veNftTokenIds)) ||
        Object.entries(runtime.cfg.contracts).some(([key, value]) => current.protocol.contracts[key as keyof Snapshot["protocol"]["contracts"]] !== value.toLowerCase())) throw new Error("Snapshot scope mismatch.");
    const report = compareWalletSnapshots(history.snapshot, current);
    report.reportId = requestId;
    report.reportSaved = true;
    report.baselineSaved = complete(current);
    const body = JSON.stringify({ version: 2, scope, snapshot: complete(current) ? current : history.snapshot, reports: [...history.reports, report] });
    if (Buffer.byteLength(body) > MAX_BYTES) throw new HistoryError("HISTORY_FULL");
    fs.writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
    const tempFd = fs.openSync(temp, "r");
    try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
    runtime.signal?.throwIfAborted();
    fs.renameSync(temp, file);
    return report;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.unlinkSync(lock);
  }
}
