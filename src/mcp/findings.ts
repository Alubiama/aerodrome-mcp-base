import { formatUnits } from "viem";
import * as z from "zod/v4";
import { walletSnapshotSchema } from "./schema.js";

type Snapshot = z.infer<typeof walletSnapshotSchema>;
type Change = { section: "protocol" | "voting" | "rewards" | "balances" | "locks"; key: string; kind: string; before: string | boolean | null; after: string | boolean | null; deltaRaw: string | null };
export const findingSchema = z.strictObject({
  code: z.enum(["BASELINE_CREATED", "SECTION_UNAVAILABLE", "EPOCH_CHANGED", "OWNER_CHANGED", "VOTING_POWER_CHANGED", "REWARD_CHANGED", "ROW_APPEARED", "ROW_NO_LONGER_OBSERVED", "VALUE_CHANGED", "SECTION_BASELINE_CREATED", "BALANCE_CHANGED", "LOCK_CHANGED"]),
  level: z.enum(["INFO", "ATTENTION"]), section: z.enum(["protocol", "voting", "rewards", "balances", "locks"]),
  key: z.string().nullable(), message: z.string(),
  fromBlock: z.string().nullable(), toBlock: z.string(),
  token: z.string().nullable(), decimals: z.number().int().min(0).max(36).nullable(),
  deltaFormatted: z.string().nullable(), sources: z.array(z.string())
});
const labels: Record<string, string> = {
  poolCount: "Pool count", totalVoteWeightRaw: "Total voting weight", maxPoolsPerVote: "Maximum pools per vote",
  normalVotingOpen: "Normal voting window", currentVotingPowerRaw: "Voting power", usedWeightRaw: "Used voting weight",
  lastVotedAt: "Last vote time", votedThisEpoch: "Voted this epoch", owner: "Owner",
  gauge: "Gauge contract", gaugeAlive: "Gauge active", voteWeightRaw: "Pool vote weight", poolWeightRaw: "Total pool weight"
};
const display = (value: Change["before"]) => value === null ? "not observed" : value === true ? "yes" : value === false ? "no" : value;
function rewardRows(snapshot: Snapshot) {
  return new Map<string, Snapshot["rewards"]["gaugeRewards"][number]>([
    ...snapshot.rewards.votingRewards.map(row => [`veNFT:${row.tokenId}/pool:${row.pool.toLowerCase()}/${row.type}:${row.rewardContract.toLowerCase()}/token:${row.token.toLowerCase()}/amountRaw`, row] as const),
    ...snapshot.rewards.gaugeRewards.map(row => [`gauge:${row.gauge.toLowerCase()}/token:${row.token.toLowerCase()}/amountRaw`, row] as const)
  ]);
}
export function explainChanges(previous: Snapshot | null, current: Snapshot, changes: Change[], unavailable: ("voting" | "rewards" | "balances" | "locks")[]) {
  const base = { key: null, level: "INFO" as const, fromBlock: previous?.observation.blockNumber ?? null, toBlock: current.observation.blockNumber, token: null, decimals: null, deltaFormatted: null,
    sources: [`https://basescan.org/block/${current.observation.blockNumber}`, ...(previous ? [`https://basescan.org/block/${previous.observation.blockNumber}`] : [])] };
  const findings: z.infer<typeof findingSchema>[] = [];
  if (!previous && current.status === "VERIFIED_BOUNDED_SCOPE") findings.push({ ...base, code: "BASELINE_CREATED", section: "protocol", message: "The first comparison baseline was created. Changes cannot be determined yet." });
  for (const section of unavailable) findings.push({ ...base, code: "SECTION_UNAVAILABLE", level: "ATTENTION", section, message: `${section}: evidence is incomplete; this section was not compared. The previous complete baseline was retained.` });
  if (previous && previous.protocol.epoch.start !== current.protocol.epoch.start) findings.push({ ...base, code: "EPOCH_CHANGED", section: "protocol", message: "The epoch changed. This comparison crosses an epoch boundary; a reward change alone does not establish realized income." });
  if (current.assets && !previous?.assets && current.status === "VERIFIED_BOUNDED_SCOPE") {
    for (const section of ["balances", "locks"] as const) findings.push({ ...base, fromBlock: null, code: "SECTION_BASELINE_CREATED", section,
      message: `${section}: the first complete observation is available. Earlier snapshots did not record this section; no change or deposit is inferred.` });
  }
  const beforeRows = previous ? rewardRows(previous) : new Map();
  const afterRows = rewardRows(current);
  for (const change of changes) {
    const entry: z.infer<typeof findingSchema> = { ...base, section: change.section, key: change.key, code: "VALUE_CHANGED", message: "" };
    const id = /^veNFT:(\d+)/.exec(change.key)?.[1];
    const field = change.key.split("/").at(-1)!;
    const subject = id ? `veNFT #${id}: ` : "";
    if (change.section === "balances" || change.section === "locks") {
      const asset = (snapshot: Snapshot | null) => change.section === "balances"
        ? snapshot?.assets?.liquidBalances.find(row => `token:${row.token?.toLowerCase() ?? "native"}/amountRaw` === change.key)
        : snapshot?.assets?.locks.find(row => row.tokenId === id);
      const before = asset(previous), after = asset(current), row = after ?? before;
      const known = (value: typeof row) => value && value.decimals !== null && ["CANONICAL", "ONCHAIN"].includes(value.decimalsSource);
      entry.token = row?.token ?? null;
      if (row) entry.sources = [...base.sources, row.source];
      const numeric = field === "amountRaw" || field === "principalRaw";
      if (numeric && known(before) && known(after) && before!.decimals === after!.decimals && before!.token?.toLowerCase() === after!.token?.toLowerCase()) {
        entry.decimals = after!.decimals;
        entry.deltaFormatted = change.deltaRaw === null ? null : formatUnits(BigInt(change.deltaRaw), after!.decimals!);
      }
      const value = (raw: Change["before"], meta: typeof row) => numeric && raw !== null
        ? known(meta) ? formatUnits(BigInt(String(raw)), meta!.decimals!) : `${raw} raw units (decimals unknown)`
        : display(raw);
      entry.code = change.kind === "APPEARED" ? "ROW_APPEARED" : change.kind === "NO_LONGER_OBSERVED" ? "ROW_NO_LONGER_OBSERVED" : change.section === "balances" ? "BALANCE_CHANGED" : "LOCK_CHANGED";
      entry.message = `${subject}${change.section === "balances" ? `Liquid balance of ${entry.token ?? "native ETH"}` : `Lock ${field}`}: ${value(change.before, before)} → ${value(change.after, after)}. Observed state only; missing values are unknown and the cause is not established.`;
    } else if (change.section === "rewards") {
      const before = beforeRows.get(change.key);
      const after = afterRows.get(change.key);
      const row = after ?? before;
      entry.token = row?.token ?? null;
      if (row) entry.sources = [...base.sources, `https://basescan.org/token/${row.token}`];
      const known = (value: typeof row) => value && ["ONCHAIN", "CANONICAL"].includes(value.decimalsSource);
      if (known(before) && known(after) && before!.decimals === after!.decimals) {
        entry.decimals = after!.decimals;
        entry.deltaFormatted = change.deltaRaw !== null ? formatUnits(BigInt(change.deltaRaw), after!.decimals) : null;
      }
      const value = (raw: Change["before"], metadata: typeof row) => raw === null ? "not observed" : known(metadata) ? formatUnits(BigInt(String(raw)), metadata!.decimals) : `${raw} raw units (decimals unknown)`;
      entry.code = change.kind === "APPEARED" ? "ROW_APPEARED" : change.kind === "NO_LONGER_OBSERVED" ? "ROW_NO_LONGER_OBSERVED" : "REWARD_CHANGED";
      entry.message = `${subject}reward for token ${entry.token ?? "unknown"}: ${value(change.before, before)} → ${value(change.after, after)}. ${change.kind === "CHANGED" ? "This is a change in the observed amount; its cause and realized income are not established." : "The observed row set changed; a missing row does not mean zero."}`;
    } else if (field === "owner") {
      entry.code = "OWNER_CHANGED"; entry.level = "ATTENTION";
      entry.message = `${subject}owner ${display(change.before)} → ${display(change.after)}. Review position ownership; this does not establish a sale.`;
    } else if (field === "currentVotingPowerRaw") {
      entry.code = "VOTING_POWER_CHANGED";
      const power = (value: Change["before"]) => value === null ? "not observed" : formatUnits(BigInt(String(value)), 18);
      entry.message = `${subject}voting power ${power(change.before)} → ${power(change.after)}. A voting-power change alone does not establish an AERO deposit or withdrawal.`;
    } else {
      const context = /\/pool:(0x[0-9a-f]+)/.exec(change.key)?.[1];
      entry.message = `${subject}${context ? `pool ${context}: ` : ""}${labels[field] ?? field}: ${display(change.before)} → ${display(change.after)}${field.endsWith("Raw") ? " (raw weight units)" : ""}.`;
    }
    findings.push(entry);
  }
  return findings;
}

/** Render legacy finding evidence in English without translating untrusted stored prose. */
export function renderLegacyFinding(finding: Omit<z.infer<typeof findingSchema>, "message">, change?: Change): string {
  const notes: Record<z.infer<typeof findingSchema>["code"], string> = {
    SECTION_BASELINE_CREATED: "The first complete section observation is available; earlier values are unknown.",
    BALANCE_CHANGED: "The observed liquid balance changed; its cause is not established.",
    LOCK_CHANGED: "The observed lock state changed; its cause is not established.",
    BASELINE_CREATED: "The first comparison baseline was created. Changes cannot be determined yet.",
    SECTION_UNAVAILABLE: "Evidence is incomplete; this section was not compared. The previous complete baseline was retained.",
    EPOCH_CHANGED: "The epoch changed. A reward change alone does not establish realized income.",
    OWNER_CHANGED: "The observed owner changed. This does not establish a sale.",
    VOTING_POWER_CHANGED: "Voting power changed. This alone does not establish an AERO deposit or withdrawal.",
    REWARD_CHANGED: "The observed reward amount changed. Its cause and realized income are not established.",
    ROW_APPEARED: "A row appeared in the observed scope; its earlier value is unknown.",
    ROW_NO_LONGER_OBSERVED: "A row is no longer observed; its current value is unknown, not zero.",
    VALUE_CHANGED: "An observed value changed."
  };
  const detail = change ? ` ${change.key}: ${display(change.before)} → ${display(change.after)}${change.deltaRaw !== null ? " (raw units)" : ""}.` : "";
  return `${notes[finding.code]}${detail}`;
}
