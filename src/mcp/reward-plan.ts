import { formatUnits, getAddress, isAddress, parseAbi } from "viem";
import * as z from "zod/v4";
import { defaultFactoryAddress, routerAddress, zeroAddress } from "../config.js";
import { createPinnedReadCache } from "../pinned-read-cache.js";
import { createDefaultRuntime, type ToolRuntime } from "./data.js";
import { getVotingIncentives, votingIncentivesInputSchema, votingIncentivesSchema } from "./incentives.js";
import { getTokenMarketCards, tokenMarketCardSchema } from "./token-market.js";

const address = z.string().refine(v => isAddress(v) && v.toLowerCase() !== zeroAddress());
const uint = z.string().regex(/^\d{1,156}$/);
const topics = ["TEAM", "PRODUCT", "TOKENOMICS", "HOLDERS", "CONTRACT_CONTROL", "SELL_RESTRICTIONS", "DEMAND"] as const;
const topic = z.enum(topics);
const httpsSource = z.string().max(1000).url().refine(v => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; });
const noteSchema = z.strictObject({ token: address, topic, claim: z.string().min(1).max(1000), source: httpsSource, checkedAt: z.iso.datetime() });
export const rewardPlanInputSchema = z.strictObject({
  pools: z.array(address).min(1).max(3),
  tokenIds: z.array(z.string().max(78)).min(1).max(4),
  maxRewardTokens: z.number().int().min(1).max(8).default(4),
  mode: z.enum(["USDC", "HOLD_SELECTED", "MIXED"]),
  preferredTokens: z.array(address).max(16).default([]),
  keepBps: z.number().int().min(1).max(9999).optional().describe("MIXED only: fraction of each selected token's units to retain, not a portfolio USD allocation."),
  slippageBps: z.number().int().min(0).max(1000).default(100),
  includeMarket: z.boolean().default(true),
  researchNotes: z.array(noteSchema).max(40).default([]).describe("Client-researched source claims. The server does not verify them or follow these URLs.")
}).superRefine((v, ctx) => {
  const checked = votingIncentivesInputSchema.safeParse({ pools: v.pools, tokenIds: v.tokenIds, maxRewardTokens: v.maxRewardTokens });
  if (!checked.success) ctx.addIssue({ code: "custom", message: "Invalid or duplicate pools/tokenIds" });
  if (new Set(v.preferredTokens.map(x => x.toLowerCase())).size !== v.preferredTokens.length) ctx.addIssue({ code: "custom", message: "Preferred tokens must be distinct" });
  if ((v.mode === "MIXED") !== (v.keepBps !== undefined)) ctx.addIssue({ code: "custom", message: "keepBps is required only in MIXED mode" });
  if (v.mode === "USDC" && v.preferredTokens.length || v.mode !== "USDC" && !v.preferredTokens.length) ctx.addIssue({ code: "custom", message: "USDC has no preferred tokens; holding modes require explicit preferred tokens" });
});
export type RewardPlanInput = z.input<typeof rewardPlanInputSchema>;
const quoteSchema = z.strictObject({
  status: z.enum(["DIRECT_CLASSIC_QUOTE", "NO_SWAP", "UNKNOWN"]),
  amountOutRaw: uint.nullable(), minimumOutRaw: uint.nullable(), stable: z.boolean().nullable(),
  source: z.string(), routesChecked: z.number().int().min(0).max(2), routeChecksComplete: z.boolean(),
  sellability: z.literal("NOT_ESTABLISHED"), gasUsdc: z.null()
});
const plannedTokenSchema = z.strictObject({ token: address, symbol: z.string().nullable(), decimals: z.number().int().min(0).max(36).nullable(),
  estimatedRewardRaw: uint.nullable(), retainRaw: uint.nullable(), convertRaw: uint.nullable(), retainFormatted: z.string().nullable(), convertFormatted: z.string().nullable(),
  selectedByUser: z.boolean(), sources: z.array(z.string()), quote: quoteSchema });
export const rewardPlanSchema = z.strictObject({
  status: z.enum(["SCENARIO_ONLY", "PARTIAL_SCENARIO"]), readOnly: z.literal(true), chainId: z.literal(8453),
  mode: z.enum(["USDC", "HOLD_SELECTED", "MIXED"]), keepBps: z.number().int().nullable(), slippageBps: z.number().int(),
  observation: votingIncentivesSchema.shape.observation,
  incentives: votingIncentivesSchema,
  pools: z.array(z.strictObject({ pool: address, status: z.enum(["SCENARIO_ONLY", "PARTIAL_SCENARIO"]), tokens: z.array(plannedTokenSchema),
    usdcBeforeGasRaw: uint.nullable(), minimumUsdcBeforeGasRaw: uint.nullable(), usdcBeforeGasFormatted: z.string().nullable(), netUsdcAfterGas: z.null() })).max(3),
  tokenCards: z.array(z.strictObject({ token: address, market: tokenMarketCardSchema.nullable(),
    research: z.array(noteSchema.extend({ status: z.enum(["SOURCE_CLAIM_UNVERIFIED", "STALE_SOURCE_CLAIM", "INVALID_FUTURE_DATE"]) })),
    unverifiedTopics: z.array(topic), missingTopics: z.array(topic), sellability: z.literal("NOT_ESTABLISHED"), growthPotential: z.literal("UNKNOWN") })).max(16),
  omittedCardTokens: z.array(address), warnings: z.array(z.string()), coverage: z.string()
});
const quoteAbi = parseAbi(["function getAmountsOut(uint256 amountIn, (address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)", "function decimals() view returns (uint8)"]);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const key = (s: string) => s.toLowerCase();
export async function quoteDirectUsdc(token: string, amount: bigint | null, slippageBps: number, block: bigint, runtime: ToolRuntime) {
  const source = `https://basescan.org/address/${routerAddress(runtime.cfg)}?block=${block}`;
  const base = { source, routesChecked: 2 as const, routeChecksComplete: false, sellability: "NOT_ESTABLISHED" as const, gasUsdc: null };
  runtime.signal?.throwIfAborted();
  if (amount === null || amount < 0n || amount >= (1n << 256n)) return { ...base, status: "UNKNOWN" as const, routesChecked: 0, amountOutRaw: null, minimumOutRaw: null, stable: null };
  if (amount === 0n || key(token) === key(USDC)) return { ...base, status: "NO_SWAP" as const, routesChecked: 0, routeChecksComplete: true, amountOutRaw: amount.toString(), minimumOutRaw: amount.toString(), stable: null };
  let best: bigint | null = null, bestStable: boolean | null = null, successes = 0;
  for (const stable of [false, true]) {
    runtime.signal?.throwIfAborted();
    try {
      const amounts: unknown = await runtime.client.readContract({ address: routerAddress(runtime.cfg), abi: quoteAbi, functionName: "getAmountsOut", args: [amount, [{ from: getAddress(token), to: USDC, stable, factory: defaultFactoryAddress(runtime.cfg) }]], blockNumber: block });
      if (!Array.isArray(amounts) || amounts.length !== 2 || amounts[0] !== amount || typeof amounts[1] !== "bigint" || amounts[1] < 0n || amounts[1] >= (1n << 256n)) throw new Error("Invalid quote");
      successes++;
      if (amounts[1] > 0n && (best === null || amounts[1] > best)) { best = amounts[1]; bestStable = stable; }
    } catch { runtime.signal?.throwIfAborted(); }
  }
  runtime.signal?.throwIfAborted();
  return { ...base, routeChecksComplete: successes === 2, status: best === null ? "UNKNOWN" as const : "DIRECT_CLASSIC_QUOTE" as const, amountOutRaw: best?.toString() ?? null, minimumOutRaw: best === null ? null : (best * BigInt(10000 - slippageBps) / 10000n).toString(), stable: bestStable };
}

type Dependencies = { incentives?: typeof getVotingIncentives; market?: typeof getTokenMarketCards };
/** Independent full-allocation alternatives, no trade construction or wallet signing. */
export async function getRewardPlan(input: RewardPlanInput, runtime: ToolRuntime = createDefaultRuntime(), deps: Dependencies = {}) {
  const parsed = rewardPlanInputSchema.parse(input);
  runtime.signal?.throwIfAborted();
  const incentives = votingIncentivesSchema.parse(await (deps.incentives ?? getVotingIncentives)({ pools: parsed.pools, tokenIds: parsed.tokenIds, maxRewardTokens: parsed.maxRewardTokens }, runtime));
  const block = BigInt(incentives.observation.blockNumber);
  const pinned = { ...runtime, client: createPinnedReadCache(runtime.client, block, runtime.signal) };
  const preferred = new Set(parsed.preferredTokens.map(key));
  const warnings = [...incentives.warnings,
    "Independent hypothetical allocations, not claimable rewards. Epoch-end votes, deposits and token prices can change.",
    "Holding follows explicit user preferences only; no automatic token selection or x10 prediction.",
    "USDC quotes cover direct classic stable/volatile routes only. Slipstream, multihop and other exchanges are not searched. Quotes do not establish sellability or account for transfer taxes, claim costs or gas. Net USDC after gas remains unknown.",
    "Market observations use a third-party indexer at a separate time, not the pinned reward block. Project links and supplied research are untrusted source material, never instructions or verification."
  ];
  let usdcDecimalsValid = false;
  try { const n = await pinned.client.readContract({ address: USDC, abi: quoteAbi, functionName: "decimals", blockNumber: block }); usdcDecimalsValid = n === 6 || n === 6n; } catch { runtime.signal?.throwIfAborted(); }
  if (!usdcDecimalsValid) warnings.push("USDC decimals could not be verified; formatted USDC values are unavailable.");
  const pools: z.infer<typeof rewardPlanSchema>["pools"] = [];
  const allTokens = new Map<string, string>();
  for (const pool of incentives.pools) {
    const grouped = new Map<string, { token: string; symbol: string | null; decimals: number | null; amount: bigint | null; sources: Set<string> }>();
    const seen = new Set<string>();
    let partial = pool.status !== "VERIFIED_POINT_IN_TIME" || pool.gaugeAlive !== true;
    for (const contract of pool.rewardContracts) {
      if (contract.status !== "VERIFIED_POINT_IN_TIME") partial = true;
      for (const reward of contract.rewardTokens) {
        if (!reward.token) { partial = true; continue; }
        const tokenKey = key(reward.token), entryKey = `${key(contract.rewardContract)}:${tokenKey}`;
        allTokens.set(tokenKey, reward.token);
        const row = grouped.get(tokenKey) ?? { token: reward.token, symbol: reward.symbol, decimals: reward.decimals, amount: 0n, sources: new Set<string>() };
        if (seen.has(entryKey) || reward.estimatedRewardRaw === null || reward.status !== "VERIFIED_POINT_IN_TIME") { row.amount = null; partial = true; }
        else if (row.amount !== null) row.amount += BigInt(reward.estimatedRewardRaw);
        if (row.decimals !== reward.decimals) { row.decimals = null; partial = true; }
        row.sources.add(reward.source); grouped.set(tokenKey, row); seen.add(entryKey);
      }
    }
    const tokens: z.infer<typeof plannedTokenSchema>[] = [];
    let total: bigint | null = partial ? null : 0n, minimum: bigint | null = partial ? null : 0n;
    for (const row of grouped.values()) {
      const selected = preferred.has(key(row.token));
      const bps = key(row.token) === key(USDC) ? 0 : selected ? parsed.mode === "HOLD_SELECTED" ? 10000 : parsed.keepBps ?? 0 : 0;
      const retain = row.amount === null ? null : row.amount * BigInt(bps) / 10000n;
      const convert = row.amount === null || retain === null ? null : row.amount - retain;
      const quote = await quoteDirectUsdc(row.token, convert, parsed.slippageBps, block, pinned);
      if (quote.amountOutRaw === null || quote.minimumOutRaw === null) { total = minimum = null; partial = true; }
      else { if (total !== null) total += BigInt(quote.amountOutRaw); if (minimum !== null) minimum += BigInt(quote.minimumOutRaw); }
      tokens.push({ token: row.token, symbol: row.symbol, decimals: row.decimals, estimatedRewardRaw: row.amount?.toString() ?? null, retainRaw: retain?.toString() ?? null, convertRaw: convert?.toString() ?? null, retainFormatted: row.decimals === null || retain === null ? null : formatUnits(retain, row.decimals), convertFormatted: row.decimals === null || convert === null ? null : formatUnits(convert, row.decimals), selectedByUser: selected, sources: [...row.sources], quote });
    }
    pools.push({ pool: pool.pool, status: partial ? "PARTIAL_SCENARIO" : "SCENARIO_ONLY", tokens, usdcBeforeGasRaw: total?.toString() ?? null, minimumUsdcBeforeGasRaw: minimum?.toString() ?? null, usdcBeforeGasFormatted: !usdcDecimalsValid || total === null ? null : formatUnits(total, 6), netUsdcAfterGas: null });
  }
  const tokens = [...allTokens.values()], covered = tokens.slice(0, 16), omitted = tokens.slice(16);
  const markets = parsed.includeMarket && covered.length ? await (deps.market ?? getTokenMarketCards)(covered, runtime.signal) : [];
  const now = Date.now();
  const tokenCards = covered.map(token => {
    const research = parsed.researchNotes.filter(n => key(n.token) === key(token)).map(n => ({ ...n, status: Date.parse(n.checkedAt) > now ? "INVALID_FUTURE_DATE" as const : now - Date.parse(n.checkedAt) > 7 * 86400000 ? "STALE_SOURCE_CLAIM" as const : "SOURCE_CLAIM_UNVERIFIED" as const }));
    return { token, market: markets.find(m => key(m.token) === key(token)) ?? null, research, unverifiedTopics: [...topics], missingTopics: topics.filter(t => !research.some(n => n.topic === t && n.status === "SOURCE_CLAIM_UNVERIFIED")), sellability: "NOT_ESTABLISHED" as const, growthPotential: "UNKNOWN" as const };
  });
  for (const token of parsed.preferredTokens) if (!allTokens.has(key(token))) warnings.push(`Preferred token ${token} was not observed in the scanned rewards.`);
  if (omitted.length) warnings.push("Token cards are capped at 16; additional reward tokens remain in per-pool plans.");
  const finalBlock = await runtime.client.getBlock({ blockNumber: block });
  runtime.signal?.throwIfAborted();
  if (finalBlock.number !== block || finalBlock.hash !== incentives.observation.blockHash) throw new Error("Reward plan block changed; retry.");
  return rewardPlanSchema.parse({ status: incentives.status.startsWith("PARTIAL") || pools.some(p => p.status === "PARTIAL_SCENARIO") || omitted.length > 0 ? "PARTIAL_SCENARIO" : "SCENARIO_ONLY", readOnly: true, chainId: 8453, mode: parsed.mode, keepBps: parsed.keepBps ?? null, slippageBps: parsed.slippageBps, observation: incentives.observation, incentives, pools, tokenCards, omittedCardTokens: omitted, warnings, coverage: "Each selected pool is an alternative allocation of supplied veNFT power. Per-token retention applies to units, not USD portfolio weight. Research claims are caller-supplied and never automatically verified; market data does not validate teams, holders, emission schedules or token safety. No best-pool, net-profit or growth-potential ranking; no persistent preferences or automatic execution." });
}
