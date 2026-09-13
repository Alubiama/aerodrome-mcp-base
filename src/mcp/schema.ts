import * as z from "zod/v4";
import { walletAssetsSchema } from "./assets-schema.js";

const uint = z.string().regex(/^\d+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const date = z.iso.datetime();
const observation = z.strictObject({
  observedAt: date, blockNumber: uint,
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), blockTimestamp: date
});
const common = { readOnly: z.literal(true), chainId: z.literal(8453), observation, warnings: z.array(z.string()) };
const epoch = z.strictObject({ start: date, next: date, normalVoteStart: date, normalVoteEnd: date, normalVotingOpen: z.boolean() });
const protocol = z.strictObject({
  ...common, status: z.literal("VERIFIED_POINT_IN_TIME"), chain: z.literal("Base mainnet"),
  contracts: z.strictObject({ voter: address, router: address, defaultFactory: address, votingEscrow: address }),
  protocol: z.strictObject({ poolCount: uint, totalVoteWeightRaw: uint, maxPoolsPerVote: uint }),
  epoch, coverage: z.strictObject({ scope: z.string(), pricing: z.string(), transactions: z.string() })
});
const voting = z.strictObject({
  ...common, status: z.enum(["VERIFIED_POINT_IN_TIME", "PARTIAL_POINT_IN_TIME"]), epoch,
  totalProtocolWeightRaw: uint,
  positions: z.array(z.strictObject({
    tokenId: uint, owner: address, currentVotingPowerRaw: uint, usedWeightRaw: uint,
    shareOfProtocolWeightBps: uint.nullable(), lastVotedAt: date.nullable(), votedThisEpoch: z.boolean(),
    pools: z.array(z.strictObject({ pool: address, gauge: address, gaugeAlive: z.boolean(), voteWeightRaw: uint, poolWeightRaw: uint, shareOfPoolBps: uint.nullable() }))
  })),
  coverage: z.strictObject({ scope: z.string(), historicalVotes: z.string(), profitability: z.string() })
});
const reward = { gauge: address, token: address, symbol: z.string(), decimals: z.number().int().min(0).max(36), decimalsSource: z.enum(["ONCHAIN", "CANONICAL", "ASSUMED", "UNKNOWN"]).default("UNKNOWN"), amountRaw: uint, amountFormatted: z.string().regex(/^\d+(\.\d+)?$/).nullable() };
const rewards = z.strictObject({
  ...common, status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]), wallet: address,
  configuredTokenIds: z.array(uint),
  excludedTokenIds: z.array(z.strictObject({ tokenId: uint, owner: address, reason: z.literal("NOT_OWNED") })).default([]),
  votingRewards: z.array(z.strictObject({ ...reward, tokenId: uint, pool: address, type: z.enum(["bribe", "fee"]), rewardContract: address })),
  gaugeRewards: z.array(z.strictObject(reward)),
  totals: z.strictObject({ examinedItems: z.number().int().nonnegative(), votingRewardItems: z.number().int().nonnegative(), gaugeRewardItems: z.number().int().nonnegative() }),
  coverage: z.strictObject({ scope: z.string(), historicalUnclaimedPools: z.string(), tokenPrices: z.string(), displayMetadata: z.string(), realizableValue: z.string() })
});

export const walletSnapshotSchema = z.strictObject({
  ...common, status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]),
  protocol, voting, rewards, assets: walletAssetsSchema.optional(),
  coverage: z.strictObject({ scope: z.string(), consistency: z.string(), historicalRewards: z.string(), pricing: z.string() })
});

export const poolComparisonInputSchema = z.strictObject({
  pools: z.array(address.refine(value => !/^0x0{40}$/.test(value), "Pool must be nonzero"))
    .min(2).max(16)
    .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, "Pools must be distinct")
});
const missingPool = {
  pool: address, gauge: z.null(), gaugeAlive: z.null(), voteWeightRaw: z.null(),
  shareOfProtocolWeightBps: z.null(), bribeContract: z.null(), feeContract: z.null()
};
export const poolComparisonSchema = z.strictObject({
  ...common, status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]),
  voter: address, epoch, totalProtocolWeightRaw: uint,
  pools: z.array(z.discriminatedUnion("status", [
    z.strictObject({ pool: address, status: z.literal("VERIFIED_POINT_IN_TIME"), gauge: address,
      gaugeAlive: z.boolean(), voteWeightRaw: uint, shareOfProtocolWeightBps: uint.nullable(),
      bribeContract: address.nullable(), feeContract: address.nullable() }),
    z.strictObject({ ...missingPool, status: z.literal("NOT_REGISTERED") }),
    z.strictObject({ ...missingPool, status: z.literal("READ_FAILED") })
  ])).min(2).max(16),
  coverage: z.strictObject({ scope: z.string(), consistency: z.string(), weights: z.string(), rewards: z.string(), valuation: z.string() })
});
