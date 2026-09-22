import * as z from "zod/v4";
import { formatUnits } from "viem";
import { getVotingIncentives, votingIncentivesInputSchema, votingIncentivesSchema } from "./incentives.js";
import { createDefaultRuntime, type ToolRuntime } from "./data.js";
import { splitVotingPower } from "./allocation-math.js";

export const allocationsInputSchema = z.strictObject({
  pools: votingIncentivesInputSchema.shape.pools.refine(p => p.length <= 5, "At most five pools"),
  tokenIds: votingIncentivesInputSchema.shape.tokenIds.unwrap(),
  scenarios: z.array(z.strictObject({
    name: z.string().trim().min(1).max(60),
    weightsBps: z.array(z.number().int().min(0).max(10000)).min(1).max(5)
  })).min(1).max(4),
  maxRewardTokens: z.number().int().min(1).max(16).default(8)
}).refine(v => v.scenarios.every(s => s.weightsBps.length === v.pools.length && s.weightsBps.reduce((a,b) => a+b,0) === 10000), "Each scenario needs one weight per pool, summing to 10000")
.refine(v => new Set(v.scenarios.map(s => s.name)).size === v.scenarios.length, "Scenario names must be distinct");
const uint = z.string().regex(/^\d+$/);
const reward = z.strictObject({ token: z.string().nullable(), symbol: z.string().nullable(), estimatedRewardRaw: uint.nullable(), estimatedRewardFormatted: z.string().nullable(), decimals: z.number().nullable() });
const allocationResultSchema = z.strictObject({
  name: z.string(), unallocatedRoundingRaw: uint.nullable(), complete: z.boolean(),
  pools: z.array(z.strictObject({ pool: z.string(), weightBps: z.number(), allocatedVoteRaw: uint.nullable(),
    contracts: z.array(z.strictObject({ rewardContract: z.string(), denominatorRaw: uint.nullable(), rewards: z.array(reward) })) })),
  tokenSubtotals: z.array(z.strictObject({ token: z.string(), estimatedRewardRaw: uint, complete: z.boolean() }))
});
export const allocationsSchema = z.strictObject({
  readOnly: z.literal(true), status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]),
  evidence: votingIncentivesSchema,
  scenarios: z.array(allocationResultSchema.extend({
    sensitivity: z.array(z.strictObject({
      otherVoteIncreaseBps: z.number().int(), result: allocationResultSchema,
      tokenChanges: z.array(z.strictObject({token:z.string(), decreaseRaw:uint, decreaseBps:uint.nullable(),complete:z.boolean()}))
    })).length(3)
  })),
  warnings: z.array(z.string())
});
export function compareAllocationEvidence(input: z.input<typeof allocationsInputSchema>, raw: z.infer<typeof votingIncentivesSchema>) {
  const p = allocationsInputSchema.parse(input), evidence = votingIncentivesSchema.parse(raw);
  if (evidence.scenario !== "FULL_ALLOCATION_TOKEN_IDS" || evidence.pools.length !== p.pools.length || evidence.pools.some((pool,i) => pool.pool.toLowerCase() !== p.pools[i].toLowerCase()) || evidence.tokenIds.map(BigInt).join() !== p.tokenIds.map(BigInt).join()) throw new Error("Allocation evidence does not match request");
  const contracts = evidence.pools.flatMap(pool => pool.rewardContracts.map(c => c.rewardContract.toLowerCase()));
  if (new Set(contracts).size !== contracts.length) throw new Error("Repeated reward contract across pools");
  const known = evidence.candidateVoteRaw !== null && evidence.tokenPositions.length === p.tokenIds.length && evidence.tokenPositions.every(t => t.status === "NORMAL" && t.currentVotingPowerRaw !== null);
  const powers = known ? evidence.tokenPositions.map(t => BigInt(t.currentVotingPowerRaw!)) : [];
  const calculate = (s: typeof p.scenarios[number], increaseBps: number) => {
    const split = known ? splitVotingPower(powers,s.weightsBps) : null;
    let complete = known && evidence.status === "VERIFIED_BOUNDED_SCOPE";
    const sums = new Map<string,bigint>();
    const pools = evidence.pools.map((pool,i) => {
      const allocated = split?.[i] ?? null;
      if (pool.status !== "VERIFIED_POINT_IN_TIME" || !pool.gaugeAlive || pool.rewardContracts.length === 0) complete = false;
      const contracts = pool.rewardContracts.map(c => {
        const valid = known && pool.gaugeAlive === true && c.totalSupplyRaw !== null && c.removedExistingVoteRaw !== null && BigInt(c.removedExistingVoteRaw) <= BigInt(c.totalSupplyRaw);
        const other = valid ? BigInt(c.totalSupplyRaw!) - BigInt(c.removedExistingVoteRaw!) : null;
        const denominator = other === null ? null : other + other * BigInt(increaseBps) / 10000n + allocated!;
        const rewards = c.rewardTokens.map(t => {
          // Sum each NFT's individually floored reward share, not a pooled approximation.
          const exact = !valid || t.depositedRaw === null ? null : denominator === 0n ? 0n : powers.reduce((total,power) => total + BigInt(t.depositedRaw!) * (power * BigInt(s.weightsBps[i]) / 10000n) / denominator!,0n);
          if (exact === null) complete = false;
          if (t.token !== null && exact !== null) sums.set(t.token.toLowerCase(),(sums.get(t.token.toLowerCase()) ?? 0n)+exact);
          return {token:t.token,symbol:t.symbol,decimals:t.decimals,estimatedRewardRaw:exact?.toString() ?? null,estimatedRewardFormatted:exact !== null && t.decimals !== null ? formatUnits(exact,t.decimals) : null};
        });
        return {rewardContract:c.rewardContract,denominatorRaw:denominator?.toString() ?? null,rewards};
      });
      return {pool:pool.pool,weightBps:s.weightsBps[i],allocatedVoteRaw:allocated?.toString() ?? null,contracts};
    });
    return {name:s.name,complete,unallocatedRoundingRaw:split ? (powers.reduce((a,b)=>a+b,0n)-split.reduce((a,b)=>a+b,0n)).toString():null,pools,tokenSubtotals:[...sums].map(([token,n])=>({token,estimatedRewardRaw:n.toString(),complete}))};
  };
  const scenarios = p.scenarios.map(s => {
    const baseline = calculate(s,0);
    const sensitivity = [2000,5000,10000].map(otherVoteIncreaseBps => {
      const result = calculate(s,otherVoteIncreaseBps);
      const tokenChanges = baseline.tokenSubtotals.map(base => {
        const stressed = result.tokenSubtotals.find(t=>t.token===base.token)!;
        const original = BigInt(base.estimatedRewardRaw), decrease = original-BigInt(stressed.estimatedRewardRaw);
        return {token:base.token,decreaseRaw:decrease.toString(),decreaseBps:original===0n?null:(decrease*10000n/original).toString(),complete:base.complete&&stressed.complete};
      });
      return {otherVoteIncreaseBps,result,tokenChanges};
    });
    return {...baseline,sensitivity};
  });
  return allocationsSchema.parse({readOnly:true,status:scenarios.every(s=>s.complete)?"VERIFIED_BOUNDED_SCOPE":"PARTIAL_BOUNDED_SCOPE", evidence,scenarios,warnings:[...evidence.warnings,"Scenario results replace the independent full-allocation estimates in evidence. Each scenario applies the same specified basis-point split to every supplied veNFT; rounding is per veNFT. Subtotals cover only observed reward entries, never sum different token addresses. No USD ranking, optimizer, ownership, eligibility, transaction simulation, claimable amount or guaranteed payout. Deposits and competing votes may change before epoch end. Sensitivity uniformly increases each reward contract's competing weight (supply minus existing supplied-veNFT weight) by 20%, 50%, 100%, flooring added raw weight; own allocations and deposits remain fixed. This is a stress assumption, not a forecast or guaranteed range. Zero observed competing weight stays zero under proportional stress; it does not rule out new voters. Changes on incomplete subtotals are incomplete, and percent decrease is null for a zero baseline."]});
}
export async function getAllocationComparison(input: z.input<typeof allocationsInputSchema>, runtime: ToolRuntime = createDefaultRuntime()) {
  const p = allocationsInputSchema.parse(input);
  const evidence = await getVotingIncentives({pools:p.pools,tokenIds:p.tokenIds,maxRewardTokens:p.maxRewardTokens},runtime);
  runtime.signal?.throwIfAborted();
  return compareAllocationEvidence(p,evidence);
}
