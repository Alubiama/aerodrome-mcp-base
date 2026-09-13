import { formatUnits, getAddress, isAddress, parseAbi, type Address } from "viem";
import * as z from "zod/v4";
import { veAbi, voterAbi } from "../abi.js";
import { normalizeAddress, voterAddress, zeroAddress } from "../config.js";
import { getTokenMeta } from "../tokens.js";
import { createDefaultRuntime, getProtocolStatus, observation, type ToolRuntime } from "./data.js";

const address = z.string().refine(value => isAddress(value) && value.toLowerCase() !== zeroAddress(), "Address must be nonzero");
const uint256 = z.string().regex(/^\d{1,78}$/).refine(value => BigInt(value) > 0n && BigInt(value) < (1n << 256n), "Must be a positive uint256");
const uint = z.string().regex(/^\d+$/);
const sourceUrl = "https://raw.githubusercontent.com/aerodrome-finance/contracts/main/contracts/rewards/Reward.sol";

/** Explicit pool evidence and optional public veNFT or marginal-vote scenarios. */
export const votingIncentivesInputSchema = z.strictObject({
  pools: z.array(address).min(1).max(8).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, "Pools must be distinct"),
  additionalVoteRaw: uint256.optional().describe("Hypothetical NEW marginal votes; it does not read or remove existing wallet allocations."),
  tokenIds: z.array(uint256).min(1).max(4).refine(values => new Set(values.map(value => BigInt(value).toString())).size === values.length, "tokenIds must be distinct").optional(),
  maxRewardTokens: z.number().int().min(1).max(16).default(8)
}).refine(value => !(value.additionalVoteRaw !== undefined && value.tokenIds !== undefined), "additionalVoteRaw and tokenIds are mutually exclusive");
export type VotingIncentivesInput = z.input<typeof votingIncentivesInputSchema>;

const rewardToken = z.strictObject({
  status: z.enum(["VERIFIED_POINT_IN_TIME", "READ_FAILED"]), token: address.nullable(), symbol: z.string().nullable(),
  depositedRaw: uint.nullable(), estimatedRewardRaw: uint.nullable(), decimals: z.number().int().min(0).max(36).nullable(),
  decimalsSource: z.enum(["ONCHAIN", "CANONICAL", "UNKNOWN"]), depositedFormatted: z.string().nullable(), estimatedRewardFormatted: z.string().nullable(),
  source: z.string()
});
const rewardContract = z.strictObject({
  type: z.enum(["bribe", "fee"]), rewardContract: address, status: z.enum(["VERIFIED_POINT_IN_TIME", "PARTIAL_BOUNDED_SCOPE", "READ_FAILED"]),
  totalSupplyRaw: uint.nullable(), removedExistingVoteRaw: uint.nullable(), scenarioDenominatorRaw: uint.nullable(), rewardsListLength: uint.nullable(), scannedRewardTokens: z.number().int().nonnegative(), truncated: z.boolean(),
  rewardTokens: z.array(rewardToken), source: z.string(), rewardImplementationReference: z.literal(sourceUrl)
});
const failedPool = { gauge: z.null(), gaugeRegistered: z.null(), gaugeAlive: z.null(), poolWeightRaw: z.null(), bribeContract: z.null(), feeContract: z.null(), rewardContracts: z.array(rewardContract).max(0) };
const emptyPoolEvidence = () => ({ gauge: null, gaugeRegistered: null, gaugeAlive: null, poolWeightRaw: null, bribeContract: null, feeContract: null, rewardContracts: [] as never[] });
export const votingIncentivesSchema = z.strictObject({
  status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]), readOnly: z.literal(true), chainId: z.literal(8453),
  observation: z.strictObject({ observedAt: z.iso.datetime(), blockNumber: uint, blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), blockTimestamp: z.iso.datetime() }),
  voter: address, epochStart: z.iso.datetime(), additionalVoteRaw: uint.nullable(), tokenIds: z.array(uint).max(4),
  tokenPositions: z.array(z.strictObject({ tokenId: uint, status: z.enum(["NORMAL", "UNSUPPORTED", "READ_FAILED"]), currentVotingPowerRaw: uint.nullable() })),
  scenario: z.enum(["EVIDENCE_ONLY", "MARGINAL_NEW_VOTES", "FULL_ALLOCATION_TOKEN_IDS"]), candidateVoteRaw: uint.nullable(), maxRewardTokens: z.number().int().min(1).max(16),
  pools: z.array(z.discriminatedUnion("status", [
    z.strictObject({ pool: address, status: z.literal("VERIFIED_POINT_IN_TIME"), gauge: address, gaugeRegistered: z.literal(true), gaugeAlive: z.boolean(), poolWeightRaw: uint, bribeContract: address.nullable(), feeContract: address.nullable(), rewardContracts: z.array(rewardContract) }),
    z.strictObject({ pool: address, status: z.literal("NOT_REGISTERED"), ...failedPool }),
    z.strictObject({ pool: address, status: z.literal("READ_FAILED"), ...failedPool })
  ])).min(1).max(8),
  coverage: z.strictObject({ scope: z.string(), consistency: z.string(), scenario: z.string(), rewardAccounting: z.string(), valuation: z.string(), metadata: z.string(), source: z.literal(sourceUrl) }),
  warnings: z.array(z.string())
});

// Reward.sol's public mappings, kept local so this evidence does not widen shared ABIs.
const rewardAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function rewardsListLength() view returns (uint256)",
  "function rewards(uint256) view returns (address)",
  "function tokenRewardsPerEpoch(address,uint256) view returns (uint256)",
  "function balanceOf(uint256) view returns (uint256)"
]);

function source(contract: Address, block: string) { return `https://basescan.org/address/${contract}?block=${block}`; }
function unsigned(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= (1n << 256n)) throw new Error(`Invalid uint256 for ${label}.`);
  return value;
}

/**
 * Bounded, public reward-deposit evidence for selected pools.  The estimate is
 * a Reward.sol share calculation for a hypothetical allocation, never earned().
 */
export async function getVotingIncentives(input: VotingIncentivesInput, runtime: ToolRuntime = createDefaultRuntime()) {
  const parsed = votingIncentivesInputSchema.parse(input);
  runtime.signal?.throwIfAborted();
  const pools = parsed.pools.map((value, index) => normalizeAddress(value, `pools[${index}]`));
  const additional = parsed.additionalVoteRaw === undefined ? null : BigInt(parsed.additionalVoteRaw);
  const { client } = runtime;
  const obs = await observation(client);
  if (!obs.value.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(obs.value.blockHash)) throw new Error("Incentive evidence requires a valid block hash.");
  const protocol = await getProtocolStatus({ ...runtime, pinnedObservation: obs });
  const voter = voterAddress(runtime.cfg);
  const epochStartRaw = BigInt(Math.floor(Date.parse(protocol.epoch.start) / 1_000));
  const warnings: string[] = [];
  let partial = false;
  const fail = (message: string) => { partial = true; warnings.push(message); };
  const readVoter = <T>(functionName: string, args: unknown[]) => client.readContract({ address: voter, abi: voterAbi, functionName, args, blockNumber: obs.rawBlockNumber }) as Promise<T>;
  let candidate: bigint | null = additional;
  const scenario = parsed.tokenIds ? "FULL_ALLOCATION_TOKEN_IDS" : additional === null ? "EVIDENCE_ONLY" : "MARGINAL_NEW_VOTES";
  const tokenPositions: { tokenId: string; status: "NORMAL" | "UNSUPPORTED" | "READ_FAILED"; currentVotingPowerRaw: string | null }[] = [];
  if (parsed.tokenIds) {
    candidate = 0n;
    const ve = getAddress(protocol.contracts.votingEscrow);
    for (const tokenId of parsed.tokenIds) {
      runtime.signal?.throwIfAborted();
      try {
        const [escrowType, power] = await Promise.all([
          client.readContract({ address: ve, abi: veAbi, functionName: "escrowType", args: [BigInt(tokenId)], blockNumber: obs.rawBlockNumber }),
          client.readContract({ address: ve, abi: veAbi, functionName: "balanceOfNFT", args: [BigInt(tokenId)], blockNumber: obs.rawBlockNumber })
        ]);
        if (escrowType !== 0 && escrowType !== 0n) { tokenPositions.push({ tokenId, status: "UNSUPPORTED", currentVotingPowerRaw: null }); candidate = null; fail(`veNFT #${tokenId} is not a normal escrow position; no full-allocation estimate is reported.`); continue; }
        const validPower = unsigned(power, `VotingEscrow.balanceOfNFT(${tokenId})`);
        tokenPositions.push({ tokenId, status: "NORMAL", currentVotingPowerRaw: validPower.toString() });
        if (candidate !== null) candidate += validPower;
      } catch { runtime.signal?.throwIfAborted(); tokenPositions.push({ tokenId, status: "READ_FAILED", currentVotingPowerRaw: null }); candidate = null; fail(`Current voting power for veNFT #${tokenId} could not be verified; no full-allocation estimate is reported.`); }
    }
    if (candidate === 0n) { candidate = null; fail("Supplied normal veNFTs have zero current voting power; no allocation estimate is reported."); }
  }

  const readRewardContract = async (rewardContractAddress: Address, type: "bribe" | "fee", gaugeAlive: boolean) => {
    const base = { type, rewardContract: rewardContractAddress, source: source(rewardContractAddress, obs.value.blockNumber), rewardImplementationReference: sourceUrl as typeof sourceUrl };
    let supply: bigint;
    let length: bigint;
    try {
      [supply, length] = await Promise.all([
        client.readContract({ address: rewardContractAddress, abi: rewardAbi, functionName: "totalSupply", blockNumber: obs.rawBlockNumber }),
        client.readContract({ address: rewardContractAddress, abi: rewardAbi, functionName: "rewardsListLength", blockNumber: obs.rawBlockNumber })
      ]).then(values => [unsigned(values[0], "Reward.totalSupply"), unsigned(values[1], "Reward.rewardsListLength")]);
    } catch {
      runtime.signal?.throwIfAborted();
      fail(`${type} reward contract ${rewardContractAddress} could not be read; it is unknown, not empty.`);
      return { ...base, status: "READ_FAILED" as const, totalSupplyRaw: null, removedExistingVoteRaw: null, scenarioDenominatorRaw: null, rewardsListLength: null, scannedRewardTokens: 0, truncated: false, rewardTokens: [] };
    }
    let existing = 0n;
    let existingValid = true;
    if (parsed.tokenIds) {
      for (const tokenId of parsed.tokenIds) try {
        runtime.signal?.throwIfAborted();
        existing += unsigned(await client.readContract({ address: rewardContractAddress, abi: rewardAbi, functionName: "balanceOf", args: [BigInt(tokenId)], blockNumber: obs.rawBlockNumber }), `Reward.balanceOf(${tokenId})`);
      } catch { runtime.signal?.throwIfAborted(); existingValid = false; fail(`Existing reward-contract balance for veNFT #${tokenId} at ${rewardContractAddress} could not be verified.`); }
      if (existing > supply) { existingValid = false; fail(`Reward-contract balances exceed totalSupply at ${rewardContractAddress}; no allocation estimate is reported.`); }
    }
    const scan = length > BigInt(parsed.maxRewardTokens) ? BigInt(parsed.maxRewardTokens) : length;
    const truncated = length > scan;
    if (truncated) fail(`${type} reward contract ${rewardContractAddress} has ${length} tokens; only ${scan} were scanned.`);
    const denominator = scenario === "FULL_ALLOCATION_TOKEN_IDS" && existingValid && candidate !== null ? supply - existing + candidate : scenario === "MARGINAL_NEW_VOTES" && candidate !== null ? supply + candidate : null;
    if (gaugeAlive && candidate !== null && denominator === candidate) {
      warnings.push(`No competing reward-contract weight is observed at ${rewardContractAddress}. A full-share estimate assumes no competing votes arrive before epoch end.`);
    }
    const rewardTokens: z.infer<typeof rewardToken>[] = [];
    let contractPartial = truncated;
    for (let i = 0n; i < scan; i++) {
      runtime.signal?.throwIfAborted();
      let token: Address;
      let deposited: bigint;
      try {
        token = getAddress(await client.readContract({ address: rewardContractAddress, abi: rewardAbi, functionName: "rewards", args: [i], blockNumber: obs.rawBlockNumber }) as Address);
        if (token === zeroAddress()) throw new Error("zero reward token");
        deposited = unsigned(await client.readContract({ address: rewardContractAddress, abi: rewardAbi, functionName: "tokenRewardsPerEpoch", args: [token, epochStartRaw], blockNumber: obs.rawBlockNumber }), "Reward.tokenRewardsPerEpoch");
      } catch {
        runtime.signal?.throwIfAborted();
        contractPartial = true; fail(`${type} reward token entry ${i} at ${rewardContractAddress} could not be verified.`);
        rewardTokens.push({ status: "READ_FAILED", token: null, symbol: null, depositedRaw: null, estimatedRewardRaw: null, decimals: null, decimalsSource: "UNKNOWN", depositedFormatted: null, estimatedRewardFormatted: null, source: base.source });
        continue;
      }
      let symbol: string | null = null, decimals: number | null = null, decimalsSource: "ONCHAIN" | "CANONICAL" | "UNKNOWN" = "UNKNOWN";
      try {
        const meta = await getTokenMeta(client, token, undefined, obs.rawBlockNumber);
        symbol = meta.symbol;
        if (meta.decimalsSource === "ONCHAIN" || meta.decimalsSource === "CANONICAL") { decimals = meta.decimals; decimalsSource = meta.decimalsSource; }
        else { contractPartial = true; fail(`Decimals for reward token ${token} are assumed; formatted values are unavailable.`); }
      } catch { contractPartial = true; fail(`Metadata for reward token ${token} could not be read; only raw reward evidence is available.`); }
      const marginal = gaugeAlive && denominator !== null && denominator > 0n && candidate !== null ? deposited * candidate / denominator : null;
      rewardTokens.push({ status: "VERIFIED_POINT_IN_TIME", token, symbol, depositedRaw: deposited.toString(), estimatedRewardRaw: marginal?.toString() ?? null, decimals, decimalsSource,
        depositedFormatted: decimals === null ? null : formatUnits(deposited, decimals), estimatedRewardFormatted: marginal === null || decimals === null ? null : formatUnits(marginal, decimals), source: base.source });
    }
    if (!existingValid) contractPartial = true;
    return { ...base, status: contractPartial ? "PARTIAL_BOUNDED_SCOPE" as const : "VERIFIED_POINT_IN_TIME" as const, totalSupplyRaw: supply.toString(), removedExistingVoteRaw: parsed.tokenIds && existingValid ? existing.toString() : null, scenarioDenominatorRaw: denominator?.toString() ?? null, rewardsListLength: length.toString(), scannedRewardTokens: Number(scan), truncated, rewardTokens };
  };

  const rows: any[] = [];
  for (const pool of pools) {
    runtime.signal?.throwIfAborted();
    try {
      const gauge = getAddress(await readVoter<Address>("gauges", [pool]));
      if (gauge === zeroAddress()) { rows.push({ pool, status: "NOT_REGISTERED", ...emptyPoolEvidence() }); fail(`Pool ${pool} has no registered gauge.`); continue; }
      const registered = await readVoter<boolean>("isGauge", [gauge]);
      const [alive, weight, bribeRaw, feeRaw] = await Promise.all([
        readVoter<boolean>("isAlive", [gauge]), readVoter<bigint>("weights", [pool]), readVoter<Address>("gaugeToBribe", [gauge]), readVoter<Address>("gaugeToFees", [gauge])
      ]);
      if (registered !== true) { rows.push({ pool, status: "NOT_REGISTERED", ...emptyPoolEvidence() }); fail(`Gauge ${gauge} is not registered in the configured Voter.`); continue; }
      if (typeof alive !== "boolean") throw new Error("gauge evidence invalid");
      const poolWeight = unsigned(weight, "Voter.weights");
      const bribe = getAddress(bribeRaw), fee = getAddress(feeRaw);
      const contracts = [];
      for (const [type, contract] of [["bribe", bribe], ["fee", fee]] as const) if (contract !== zeroAddress()) contracts.push(await readRewardContract(contract, type, alive));
      rows.push({ pool, status: "VERIFIED_POINT_IN_TIME", gauge, gaugeRegistered: true, gaugeAlive: alive, poolWeightRaw: poolWeight.toString(), bribeContract: bribe === zeroAddress() ? null : bribe, feeContract: fee === zeroAddress() ? null : fee, rewardContracts: contracts });
      if (!alive) warnings.push(`Gauge ${gauge} is not live: reward deposits remain evidence, but no marginal estimate is reported.`);
    } catch {
      runtime.signal?.throwIfAborted(); fail(`Pool ${pool}: gauge or reward evidence could not be verified; missing values are unknown, not zero.`);
      rows.push({ pool, status: "READ_FAILED", ...emptyPoolEvidence() });
    }
  }
  const finalBlock = await client.getBlock({ blockNumber: obs.rawBlockNumber });
  runtime.signal?.throwIfAborted();
  if (finalBlock.number !== obs.rawBlockNumber || finalBlock.hash !== obs.value.blockHash) throw new Error("Incentive evidence block changed during reads; retry.");
  return votingIncentivesSchema.parse({ status: partial ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE", readOnly: true, chainId: 8453, observation: obs.value, voter, epochStart: protocol.epoch.start, additionalVoteRaw: additional?.toString() ?? null, tokenIds: parsed.tokenIds ?? [], tokenPositions, scenario, candidateVoteRaw: candidate?.toString() ?? null, maxRewardTokens: parsed.maxRewardTokens, pools: rows,
    coverage: { scope: "explicit selected pools and at most the requested reward-token entries per bribe/fee contract at one Base block", consistency: "block-number pinned reads with final block hash verification; RPC trust required", scenario: "MARGINAL_NEW_VOTES adds hypothetical new votes. FULL_ALLOCATION_TOKEN_IDS subtracts supplied veNFT balances from each reward contract then hypothetically allocates all supplied normal-position power to each selected pool independently; ownership and eligibility are not established. Epoch-end deposits and votes may change; every pool is an alternative scenario, not simultaneous full allocations.", rewardAccounting: "Reward.sol totalSupply and tokenRewardsPerEpoch mappings are used for a pro-rata scenario only; earned() uses epoch-end checkpoints, so this is not actual earnings or a guaranteed payout", valuation: "No APR, USD price, liquidity, volume, profitability, or ranking is calculated", metadata: "Token symbols and decimals are untrusted display metadata; assumed decimals leave formatted values null", source: sourceUrl }, warnings });
}
