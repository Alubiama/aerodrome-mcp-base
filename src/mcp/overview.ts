import { formatUnits, getAddress, isAddress, type Address } from "viem";
import * as z from "zod/v4";
import { erc20Abi, veAbi } from "../abi.js";
import { walletAddress, uniqAddresses, zeroAddress } from "../config.js";
import { getTokenMeta } from "../tokens.js";
import { createDefaultRuntime, getProtocolStatus, getVotingPosition, getWalletRewards, observation, unixSecondsToIso, type ToolRuntime } from "./data.js";
import { walletSnapshotSchema } from "./schema.js";

const address = z.string().refine(value => isAddress(value) && value.toLowerCase() !== zeroAddress());
const uint = z.string().regex(/^\d+$/);
const addresses = z.array(address).max(16).refine(values => new Set(values.map(x => x.toLowerCase())).size === values.length);
export const walletOverviewInputSchema = z.strictObject({
  wallet: address.optional().describe("Public wallet address; defaults to local configuration. No veNFT IDs required."),
  tokens: addresses.optional().describe("Additional ERC-20 balances, at most 16. ETH, escrow token and configured USDC are included by default."),
  gauges: addresses.optional().describe("Optional LP reward gauges, at most 16. Gauge discovery and LP principal valuation are not included.")
});
export type WalletOverviewInput = z.infer<typeof walletOverviewInputSchema>;
const amount = z.strictObject({
  token: address.nullable(), symbol: z.string(), status: z.enum(["VERIFIED_POINT_IN_TIME", "READ_FAILED"]),
  amountRaw: uint.nullable(), amountFormatted: z.string().nullable(),
  decimals: z.number().int().min(0).max(36).nullable(),
  decimalsSource: z.enum(["ONCHAIN", "CANONICAL", "UNKNOWN"]), source: z.string()
});
export const walletOverviewSchema = z.strictObject({
  status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]), readOnly: z.literal(true), chainId: z.literal(8453),
  wallet: address, observation: walletSnapshotSchema.shape.observation,
  liquidBalances: z.array(amount),
  discovery: z.strictObject({ status: z.enum(["COMPLETE", "PARTIAL", "READ_FAILED"]), ownedCount: uint.nullable(), tokenIds: z.array(uint).max(16), limit: z.literal(16) }),
  locks: z.array(z.strictObject({
    tokenId: uint, status: z.enum(["VERIFIED_POINT_IN_TIME", "UNSUPPORTED_MANAGED", "READ_FAILED"]),
    escrowType: z.enum(["NORMAL", "LOCKED", "MANAGED"]).nullable(),
    principalRaw: uint.nullable(), principalFormatted: z.string().nullable(), token: address.nullable(),
    unlockAt: z.iso.datetime().nullable(), permanent: z.boolean().nullable(), source: z.string()
  })),
  protocol: walletSnapshotSchema.shape.protocol,
  voting: walletSnapshotSchema.shape.voting.nullable(),
  rewards: walletSnapshotSchema.shape.rewards.nullable(),
  summaryRu: z.array(z.string()), warnings: z.array(z.string()),
  coverage: z.strictObject({ balances: z.string(), positions: z.string(), rewards: z.string(), voting: z.string(), totals: z.string(), consistency: z.string() })
});
const source = (contract: string, block: string) => `https://basescan.org/address/${contract}?block=${block}`;
function unsigned(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 256n) throw new Error("Invalid uint256 evidence.");
  return value;
}

/** Address-first evidence, bounded direct reads. No position indexer, model or transactions. */
export async function getWalletOverview(input: WalletOverviewInput = {}, runtime: ToolRuntime = createDefaultRuntime()) {
  input = walletOverviewInputSchema.parse(input);
  runtime.signal?.throwIfAborted();
  const wallet = input.wallet ? getAddress(input.wallet) : walletAddress(runtime.cfg);
  const { client } = runtime;
  if (await client.getChainId() !== 8453) throw new Error("Wrong chainId.");
  const obs = await observation(client);
  if (!obs.value.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(obs.value.blockHash)) throw new Error("Snapshot requires a valid block hash.");
  const pinned = { ...runtime, pinnedObservation: obs };
  const protocol = walletSnapshotSchema.shape.protocol.parse(await getProtocolStatus(pinned));
  const ve = protocol.contracts.votingEscrow as Address;
  const block = obs.value.blockNumber;
  const warnings: string[] = [];
  let partial = false;
  const fail = (message: string) => { runtime.signal?.throwIfAborted(); partial = true; warnings.push(message); };
  const readVe = (functionName: string, args?: unknown[]) => client.readContract({ address: ve, abi: veAbi, functionName, args, blockNumber: obs.rawBlockNumber });
  let escrowToken: Address | null = null;
  try {
    escrowToken = getAddress(await readVe("token"));
    if (escrowToken === zeroAddress()) throw new Error("Missing escrow token");
  } catch { escrowToken = null; fail("Escrow token could not be verified; its liquid balance and lock display units are unavailable."); }
  let ownedCount: bigint | null = null;
  const tokenIds: string[] = [];
  let discoveryStatus: "COMPLETE" | "PARTIAL" | "READ_FAILED" = "COMPLETE";
  try {
    ownedCount = unsigned(await readVe("balanceOf", [wallet]));
    if (ownedCount > 16n) { discoveryStatus = "PARTIAL"; fail("More than 16 owned veNFTs: only the first 16 owner-list entries were inspected."); }
    for (let index = 0n; index < (ownedCount < 16n ? ownedCount : 16n); index++) {
      runtime.signal?.throwIfAborted();
      try {
        const id = unsigned(await readVe("ownerToNFTokenIdList", [wallet, index]));
        if (id === 0n || tokenIds.includes(id.toString()) || getAddress(await readVe("ownerOf", [id])) !== wallet) throw new Error("Owner enumeration mismatch");
        tokenIds.push(id.toString());
      } catch { discoveryStatus = "PARTIAL"; fail(`Could not verify veNFT owner-list entry ${index}; it was excluded, not treated as an empty position.`); }
    }
  } catch { discoveryStatus = "READ_FAILED"; fail("Owned veNFT count could not be read; absence of discovered IDs does not mean no positions."); }
  const liquidBalances: z.infer<typeof amount>[] = [];
  try {
    const balance = unsigned(await client.getBalance({ address: wallet, blockNumber: obs.rawBlockNumber }));
    liquidBalances.push({ token: null, symbol: "ETH", status: "VERIFIED_POINT_IN_TIME", amountRaw: balance.toString(), amountFormatted: formatUnits(balance, 18), decimals: 18, decimalsSource: "CANONICAL", source: source(wallet, block) });
  } catch {
    fail("ETH balance unavailable.");
    liquidBalances.push({ token: null, symbol: "ETH", status: "READ_FAILED", amountRaw: null, amountFormatted: null, decimals: 18, decimalsSource: "CANONICAL", source: source(wallet, block) });
  }
  const tokens = uniqAddresses([...(escrowToken ? [escrowToken] : []), ...(runtime.cfg.tokens.USDC ? [getAddress(runtime.cfg.tokens.USDC)] : []), ...(input.tokens ?? []).map(x => getAddress(x))]);
  for (const token of tokens) {
    runtime.signal?.throwIfAborted();
    try {
      const balance = unsigned(await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber: obs.rawBlockNumber }));
      const meta = await getTokenMeta(client, token, undefined, obs.rawBlockNumber);
      const known = meta.decimalsSource !== "ASSUMED";
      if (!known) fail(`Decimals unavailable for ${token}; only its raw balance is reliable.`);
      liquidBalances.push({ token, symbol: meta.symbol, status: "VERIFIED_POINT_IN_TIME", amountRaw: balance.toString(), amountFormatted: known ? formatUnits(balance, meta.decimals) : null, decimals: known ? meta.decimals : null, decimalsSource: known ? meta.decimalsSource as "ONCHAIN" | "CANONICAL" : "UNKNOWN", source: source(token, block) });
    } catch {
      fail(`Token balance unavailable for ${token}.`);
      liquidBalances.push({ token, symbol: token, status: "READ_FAILED", amountRaw: null, amountFormatted: null, decimals: null, decimalsSource: "UNKNOWN", source: source(token, block) });
    }
  }
  const tokenDisplay = liquidBalances.find(row => row.token === escrowToken);
  const locks: z.infer<typeof walletOverviewSchema>["locks"] = [];
  for (const id of tokenIds) {
    runtime.signal?.throwIfAborted();
    const empty = { tokenId: id, escrowType: null, principalRaw: null, principalFormatted: null, token: escrowToken, unlockAt: null, permanent: null, source: source(ve, block) };
    try {
      const type = Number(await readVe("escrowType", [BigInt(id)]));
      if (![0, 1, 2].includes(type)) throw new Error("Unknown escrow type");
      if (type !== 0) {
        fail(`veNFT #${id} uses managed escrow: personal principal and managed rewards are not calculated.`);
        locks.push({ ...empty, status: "UNSUPPORTED_MANAGED", escrowType: type === 1 ? "LOCKED" : "MANAGED" });
        continue;
      }
      const locked = await readVe("locked", [BigInt(id)]);
      const principal = unsigned(locked.amount);
      const end = unsigned(locked.end);
      if (typeof locked.isPermanent !== "boolean") throw new Error("Invalid lock evidence");
      locks.push({ ...empty, status: "VERIFIED_POINT_IN_TIME", escrowType: "NORMAL", principalRaw: principal.toString(), principalFormatted: tokenDisplay?.decimals != null ? formatUnits(principal, tokenDisplay.decimals) : null, unlockAt: locked.isPermanent ? null : unixSecondsToIso(end, "Lock end"), permanent: locked.isPermanent });
    } catch { fail(`Locked principal unavailable for veNFT #${id}.`); locks.push({ ...empty, status: "READ_FAILED" }); }
  }
  // Explicitly supplied other wallets must never inherit the configured wallet's gauges.
  const sameWallet = runtime.cfg.walletAddress?.toLowerCase() === wallet.toLowerCase();
  const gauges = input.gauges ?? (sameWallet ? runtime.cfg.gaugeAddresses : []);
  if (gauges.length > 16) fail("Only the first 16 configured gauges are included in this overview.");
  const scoped = { ...pinned, cfg: { ...runtime.cfg, walletAddress: wallet, veNftTokenIds: tokenIds, gaugeAddresses: gauges.slice(0, 16) } };
  let voting: z.infer<typeof walletSnapshotSchema>["voting"] | null = null;
  let rewards: z.infer<typeof walletSnapshotSchema>["rewards"] | null = null;
  try {
    voting = walletSnapshotSchema.shape.voting.parse(await getVotingPosition({}, scoped));
    if (discoveryStatus !== "COMPLETE") { voting.status = "PARTIAL_POINT_IN_TIME"; voting.warnings.push("Owner discovery is incomplete; returned positions are a subset."); }
    if (voting.status.startsWith("PARTIAL")) fail("Voting evidence is partial.");
  } catch { fail("Voting evidence unavailable; balances and locks remain independently reported."); }
  try {
    rewards = walletSnapshotSchema.shape.rewards.parse(await getWalletRewards({ includeZero: true, maxItems: 200 }, scoped));
    if (discoveryStatus !== "COMPLETE" || gauges.length > 16 || locks.some(row => row.escrowType !== "NORMAL")) {
      rewards.status = "PARTIAL_BOUNDED_SCOPE";
      rewards.warnings.push("Owner/gauge discovery or managed-position coverage is incomplete.");
    }
    if (rewards.status.startsWith("PARTIAL")) fail("Reward evidence is partial.");
  } catch { fail("Rewards unavailable; balances and locks remain independently reported."); }
  const finalBlock = await client.getBlock({ blockNumber: obs.rawBlockNumber });
  runtime.signal?.throwIfAborted();
  if (finalBlock.number !== obs.rawBlockNumber || finalBlock.hash !== obs.value.blockHash) throw new Error("Snapshot block changed during reads; retry.");
  const summaryRu = [
    `Обзор на блоке ${block}. Свободные средства, блокировки, сила голоса и награды показаны отдельно.`,
    ...liquidBalances.map(row => `${row.token ? `${row.symbol} (${row.token})` : "ETH"}: ${row.amountRaw === null ? "баланс недоступен" : row.amountFormatted ?? `${row.amountRaw} минимальных единиц; точность неизвестна`}.`),
    `veNFT: найдено ${tokenIds.length}${ownedCount === null ? "; общее количество неизвестно" : ` из ${ownedCount}`}.`,
    ...locks.map(row => `veNFT #${row.tokenId}: ${row.status !== "VERIFIED_POINT_IN_TIME" ? "личная заблокированная сумма не определена" : `${row.principalFormatted ?? `${row.principalRaw} минимальных единиц`} токена ${escrowToken}; ${row.permanent ? "постоянная блокировка" : `окончание ${row.unlockAt}`}`}.`),
    `Обычное окно голосования: ${protocol.epoch.normalVotingOpen ? "открыто" : "закрыто"}. Это не полная проверка права конкретной позиции на голосование.`,
    ...(voting?.positions.map(row => `veNFT #${row.tokenId}: сила голоса ${formatUnits(BigInt(row.currentVotingPowerRaw), 18)}; ${row.votedThisEpoch ? "голос отмечен в текущей эпохе" : "голос в текущей эпохе не отмечен"}.`) ?? ["Данные о силе голоса недоступны."]),
    ...(rewards ? [...rewards.votingRewards, ...rewards.gaugeRewards].filter(row => BigInt(row.amountRaw) > 0n).map(row => `Награда ${row.symbol} (${row.token}): ${["ONCHAIN", "CANONICAL"].includes(row.decimalsSource) ? row.amountFormatted : `${row.amountRaw} минимальных единиц; точность неизвестна`}; источник ${"rewardContract" in row ? row.rewardContract : row.gauge}.`) : ["Награды недоступны."]),
    ...(partial ? ["Часть данных недоступна или выходит за охват проверки; это не нулевые балансы."] : []),
    "Награды проверены только по текущим голосам и указанным gauges. Исторические награды, стоимость LP-позиций и итоговая стоимость кошелька не рассчитаны."
  ];
  return walletOverviewSchema.parse({ status: partial ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE", readOnly: true, chainId: 8453, wallet, observation: obs.value,
    liquidBalances, discovery: { status: discoveryStatus, ownedCount: ownedCount?.toString() ?? null, tokenIds, limit: 16 }, locks, protocol, voting, rewards, summaryRu,
    warnings: [...warnings, ...(voting?.warnings ?? []), ...(rewards?.warnings ?? [])],
    coverage: { balances: "ETH, escrow token, configured USDC and explicitly requested ERC-20s; not every wallet asset", positions: "first 16 verified entries of the official escrow owner list; managed principal is unknown", rewards: "current-vote rewards and at most 16 explicitly selected gauges; historical rewards, rebases and managed rewards excluded", voting: "normal epoch window and observed voting state; eligibility, delegation and transaction success not established", totals: "no aggregate net worth; liquid balances, locked principal, voting power and rewards must not be added together", consistency: "one pinned Base block, final hash recheck; RPC trust required" }
  });
}
