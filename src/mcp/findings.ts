import { formatUnits } from "viem";
import * as z from "zod/v4";
import { walletSnapshotSchema } from "./schema.js";

type Snapshot = z.infer<typeof walletSnapshotSchema>;
type Change = { section: "protocol" | "voting" | "rewards"; key: string; kind: string; before: string | boolean | null; after: string | boolean | null; deltaRaw: string | null };
export const findingSchema = z.strictObject({
  code: z.enum(["BASELINE_CREATED", "SECTION_UNAVAILABLE", "EPOCH_CHANGED", "OWNER_CHANGED", "VOTING_POWER_CHANGED", "REWARD_CHANGED", "ROW_APPEARED", "ROW_NO_LONGER_OBSERVED", "VALUE_CHANGED"]),
  level: z.enum(["INFO", "ATTENTION"]), section: z.enum(["protocol", "voting", "rewards"]),
  key: z.string().nullable(), messageRu: z.string(),
  fromBlock: z.string().nullable(), toBlock: z.string(),
  token: z.string().nullable(), decimals: z.number().int().min(0).max(36).nullable(),
  deltaFormatted: z.string().nullable(), sources: z.array(z.string())
});
const labels: Record<string, string> = {
  poolCount: "Количество пулов", totalVoteWeightRaw: "Общий вес голосов", maxPoolsPerVote: "Лимит пулов для голосования",
  normalVotingOpen: "Обычное окно голосования", currentVotingPowerRaw: "Сила голоса", usedWeightRaw: "Использованный вес голоса",
  lastVotedAt: "Время последнего голосования", votedThisEpoch: "Голос в текущей эпохе", owner: "Владелец",
  gauge: "Контракт gauge", gaugeAlive: "Активность gauge", voteWeightRaw: "Вес голоса в пуле", poolWeightRaw: "Общий вес пула"
};
const display = (value: Change["before"]) => value === null ? "не наблюдается" : value === true ? "да" : value === false ? "нет" : value;
function rewardRows(snapshot: Snapshot) {
  return new Map<string, Snapshot["rewards"]["gaugeRewards"][number]>([
    ...snapshot.rewards.votingRewards.map(row => [`veNFT:${row.tokenId}/pool:${row.pool.toLowerCase()}/${row.type}:${row.rewardContract.toLowerCase()}/token:${row.token.toLowerCase()}/amountRaw`, row] as const),
    ...snapshot.rewards.gaugeRewards.map(row => [`gauge:${row.gauge.toLowerCase()}/token:${row.token.toLowerCase()}/amountRaw`, row] as const)
  ]);
}
export function explainChanges(previous: Snapshot | null, current: Snapshot, changes: Change[], unavailable: ("voting" | "rewards")[]) {
  const base = { key: null, level: "INFO" as const, fromBlock: previous?.observation.blockNumber ?? null, toBlock: current.observation.blockNumber, token: null, decimals: null, deltaFormatted: null,
    sources: [`https://basescan.org/block/${current.observation.blockNumber}`, ...(previous ? [`https://basescan.org/block/${previous.observation.blockNumber}`] : [])] };
  const findings: z.infer<typeof findingSchema>[] = [];
  if (!previous && current.status === "VERIFIED_BOUNDED_SCOPE") findings.push({ ...base, code: "BASELINE_CREATED", section: "protocol", messageRu: "Создан первый снимок для сравнения. Пока нельзя сказать, что изменилось." });
  for (const section of unavailable) findings.push({ ...base, code: "SECTION_UNAVAILABLE", level: "ATTENTION", section, messageRu: `${section === "voting" ? "Голосование" : "Награды"}: данные неполные, изменения раздела не рассчитаны. Прежний полный снимок сохранён.` });
  if (previous && previous.protocol.epoch.start !== current.protocol.epoch.start) findings.push({ ...base, code: "EPOCH_CHANGED", section: "protocol", messageRu: "Началась другая эпоха. Сравнение пересекает границу эпох; изменение наград само по себе не доказывает получение дохода." });
  const beforeRows = previous ? rewardRows(previous) : new Map();
  const afterRows = rewardRows(current);
  for (const change of changes) {
    const entry: z.infer<typeof findingSchema> = { ...base, section: change.section, key: change.key, code: "VALUE_CHANGED", messageRu: "" };
    const id = /^veNFT:(\d+)/.exec(change.key)?.[1];
    const field = change.key.split("/").at(-1)!;
    const subject = id ? `veNFT #${id}: ` : "";
    if (change.section === "rewards") {
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
      const value = (raw: Change["before"], metadata: typeof row) => raw === null ? "не наблюдается" : known(metadata) ? formatUnits(BigInt(String(raw)), metadata!.decimals) : `${raw} минимальных единиц (точность неизвестна)`;
      entry.code = change.kind === "APPEARED" ? "ROW_APPEARED" : change.kind === "NO_LONGER_OBSERVED" ? "ROW_NO_LONGER_OBSERVED" : "REWARD_CHANGED";
      entry.messageRu = `${subject}награда токена ${entry.token ?? "неизвестен"}: ${value(change.before, before)} → ${value(change.after, after)}. ${change.kind === "CHANGED" ? "Это изменение наблюдаемой суммы; причина и получение дохода не установлены." : "Изменился набор наблюдаемых строк; отсутствие строки не равно нулю."}`;
    } else if (field === "owner") {
      entry.code = "OWNER_CHANGED"; entry.level = "ATTENTION";
      entry.messageRu = `${subject}владелец ${display(change.before)} → ${display(change.after)}. Проверь принадлежность позиции; это не подтверждение продажи.`;
    } else if (field === "currentVotingPowerRaw") {
      entry.code = "VOTING_POWER_CHANGED";
      const power = (value: Change["before"]) => value === null ? "не наблюдается" : formatUnits(BigInt(String(value)), 18);
      entry.messageRu = `${subject}сила голоса ${power(change.before)} → ${power(change.after)}. Изменение силы голоса само по себе не доказывает пополнение или вывод AERO.`;
    } else {
      const context = /\/pool:(0x[0-9a-f]+)/.exec(change.key)?.[1];
      entry.messageRu = `${subject}${context ? `пул ${context}: ` : ""}${labels[field] ?? field}: ${display(change.before)} → ${display(change.after)}${field.endsWith("Raw") ? " (минимальные единицы веса)" : ""}.`;
    }
    findings.push(entry);
  }
  return findings;
}
