import { getAddress, parseAbi, type Address } from "viem";
import { readContractsBounded } from "../discovery.js";
import { voterAddress } from "../config.js";
import { getTokenMeta } from "../tokens.js";
import { createDefaultRuntime, getProtocolStatus, observation, type ToolRuntime } from "./data.js";
import { voterAbi } from "../abi.js";
import * as z from "zod/v4";

const uint = z.string().regex(/^\d{1,78}$/).refine(value => BigInt(value) < (1n << 256n), "Must fit uint256");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const meta = z.strictObject({ address, symbol: z.string(), decimals: z.number().int().min(0).max(36).nullable(), decimalsSource: z.enum(["ONCHAIN", "CANONICAL", "UNKNOWN"]) });
export const poolDirectoryInputSchema = z.strictObject({ beforeIndex: uint.optional(), limit: z.number().int().min(1).max(16).default(8), sinceIndex: uint.optional() });
export const poolDirectorySchema = z.strictObject({ status: z.enum(["VERIFIED_POINT_IN_TIME", "PARTIAL_BOUNDED_SCOPE"]), readOnly: z.literal(true), chainId: z.literal(8453), observation: z.strictObject({ observedAt: z.iso.datetime(), blockNumber: uint, blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), blockTimestamp: z.iso.datetime() }), voter: address, totalPoolCount: uint, scanned: z.strictObject({ fromIndex: uint, toIndex: uint, count: z.number().int().nonnegative() }), nextBeforeIndex: uint.nullable(), hasMore: z.boolean(), pools: z.array(z.strictObject({ index: uint, pool: address.nullable(), gauge: address.nullable(), gaugeAlive: z.boolean().nullable(), weightRaw: uint.nullable(), token0: meta.nullable(), token1: meta.nullable(), status: z.enum(["VERIFIED_POINT_IN_TIME", "PARTIAL"]) })), coverage: z.strictObject({ scope: z.string(), ordering: z.string(), timestamps: z.string(), rankings: z.string() }), warnings: z.array(z.string()), sources: z.array(z.string()) });
const poolAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);
const valid = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < (1n << 256n);
function nonzeroAddress(value: unknown): Address | null {
  try { const a = getAddress(value as Address); return /^0x0{40}$/.test(a) ? null : a; } catch { return null; }
}

export async function getPoolDirectory(input: z.input<typeof poolDirectoryInputSchema> = {}, runtime: ToolRuntime = createDefaultRuntime()) {
  const args = poolDirectoryInputSchema.parse(input); runtime.signal?.throwIfAborted();
  const obs = runtime.pinnedObservation ?? await observation(runtime.client);
  if (!obs.value.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(obs.value.blockHash)) throw new Error("Base RPC must return a valid block hash for a pinned directory.");
  const protocol = await getProtocolStatus({ ...runtime, pinnedObservation: { ...obs } });
  const total = BigInt(protocol.protocol.poolCount);
  const before = args.beforeIndex === undefined ? total : BigInt(args.beforeIndex);
  const since = args.sinceIndex === undefined ? 0n : BigInt(args.sinceIndex);
  if (before > total) throw new Error("beforeIndex must be <= current pool count.");
  if (since > before) throw new Error("sinceIndex must be <= beforeIndex.");
  const limit = BigInt(args.limit); const end = since > before - limit ? since : before - limit;
  const indices = Array.from({ length: Number(before - end) }, (_, i) => before - 1n - BigInt(i));
  const voter = voterAddress(runtime.cfg);
  const slots = await readContractsBounded(runtime.client, indices.map(index => ({ address: voter, abi: voterAbi, functionName: "pools", args: [index], blockNumber: obs.rawBlockNumber })), 4, false);
  const warnings: string[] = []; const rows = [];
  for (let i = 0; i < indices.length; i++) {
    runtime.signal?.throwIfAborted(); const index = indices[i]; const slot = slots[i];
    if (slot?.status !== "success" || typeof slot.result !== "string") { rows.push({ index: index.toString(), pool: null, gauge: null, gaugeAlive: null, weightRaw: null, token0: null, token1: null, status: "PARTIAL" as const }); warnings.push(`Pool index ${index} could not be read.`); continue; }
    const pool = nonzeroAddress(slot.result);
    if (!pool) { rows.push({ index: index.toString(), pool: null, gauge: null, gaugeAlive: null, weightRaw: null, token0: null, token1: null, status: "PARTIAL" as const }); warnings.push(`Invalid pool at index ${index}.`); continue; } let gauge: Address | null = null, alive: boolean | null = null, weight: string | null = null, token0 = null, token1 = null;
    const reads = await readContractsBounded(runtime.client, [
      { address: voter, abi: voterAbi, functionName: "gauges", args: [pool], blockNumber: obs.rawBlockNumber },
      { address: voter, abi: voterAbi, functionName: "weights", args: [pool], blockNumber: obs.rawBlockNumber },
      { address: pool, abi: poolAbi, functionName: "token0", blockNumber: obs.rawBlockNumber }, { address: pool, abi: poolAbi, functionName: "token1", blockNumber: obs.rawBlockNumber }
    ], 4, false);
    if (reads[0]?.status === "success" && typeof reads[0].result === "string" && !/^0x0{40}$/i.test(reads[0].result)) gauge = nonzeroAddress(reads[0].result); else warnings.push(`Gauge read failed or is zero for pool ${pool}.`);
    if (reads[1]?.status === "success" && valid(reads[1].result)) weight = reads[1].result.toString(); else warnings.push(`Weight read failed for pool ${pool}.`);
    if (gauge) {
      const checks = await readContractsBounded(runtime.client, [{ address: voter, abi: voterAbi, functionName: "isGauge", args: [gauge], blockNumber: obs.rawBlockNumber }, { address: voter, abi: voterAbi, functionName: "isAlive", args: [gauge], blockNumber: obs.rawBlockNumber }], 2, false);
      if (checks[0]?.status !== "success" || checks[0].result !== true) { warnings.push(`Gauge verification failed for pool ${pool}.`); gauge = null; alive = null; }
      else if (checks[1]?.status === "success" && typeof checks[1].result === "boolean") alive = checks[1].result; else warnings.push(`Gauge liveness read failed for pool ${pool}.`);
    }
    for (const [slotIndex, key] of [[2, "token0"], [3, "token1"]] as const) if (reads[slotIndex]?.status === "success" && typeof reads[slotIndex].result === "string") try { const token = nonzeroAddress(reads[slotIndex].result); if (!token) throw new Error("Invalid token"); const m = await getTokenMeta(runtime.client, token, undefined, obs.rawBlockNumber); const known = m.decimalsSource === "ONCHAIN" || m.decimalsSource === "CANONICAL"; const value = { ...m, decimals: known ? m.decimals : null, decimalsSource: known ? m.decimalsSource : "UNKNOWN" }; if (key === "token0") token0 = value; else token1 = value; } catch { warnings.push(`Token metadata read failed for ${pool}.`); }
    rows.push({ index: index.toString(), pool, gauge, gaugeAlive: alive, weightRaw: weight, token0, token1, status: gauge && alive !== null && weight !== null && token0 && token1 && token0.decimals !== null && token1.decimals !== null ? "VERIFIED_POINT_IN_TIME" as const : "PARTIAL" as const });
  }
  runtime.signal?.throwIfAborted(); const final = await runtime.client.getBlock({ blockNumber: obs.rawBlockNumber }); runtime.signal?.throwIfAborted(); if (final.number !== obs.rawBlockNumber || final.hash !== obs.value.blockHash) throw new Error("Snapshot block changed during reads; retry.");
  return poolDirectorySchema.parse({ status: rows.some(r => r.status === "PARTIAL") ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_POINT_IN_TIME", readOnly: true, chainId: 8453, observation: obs.value, voter, totalPoolCount: total.toString(), scanned: { fromIndex: indices.at(-1)?.toString() ?? before.toString(), toIndex: indices[0]?.toString() ?? before.toString(), count: indices.length }, nextBeforeIndex: end > since ? end.toString() : null, hasMore: end > since, pools: rows, coverage: { scope: "newest registered pools in official Voter registry", ordering: "descending Voter registration index; gauge registration order", timestamps: "pool creation/listing timestamps not read", rankings: "market rankings, liquidity, APR and completeness of all Base listings not established" }, warnings, sources: [`https://basescan.org/address/${voter}?block=${obs.value.blockNumber}`, ...rows.filter(r => r.pool).map(r => `https://basescan.org/address/${r.pool}?block=${obs.value.blockNumber}`)] });
}
