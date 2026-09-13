import * as z from "zod/v4";

const uint = z.string().regex(/^\d+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const observation = z.strictObject({
  observedAt: z.iso.datetime(), blockNumber: uint, blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), blockTimestamp: z.iso.datetime()
});
const metadataSource = z.enum(["ONCHAIN", "CANONICAL", "UNKNOWN"]);

export const walletAssetsSchema = z.strictObject({
  wallet: address, observation,
  balancesStatus: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]),
  locksStatus: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]),
  liquidBalances: z.array(z.strictObject({
    token: address.nullable(), symbol: z.string(), status: z.enum(["VERIFIED_POINT_IN_TIME", "READ_FAILED"]),
    amountRaw: uint.nullable(), decimals: z.number().int().min(0).max(36).nullable(), decimalsSource: metadataSource, source: z.string()
  })).min(1).max(3),
  locks: z.array(z.strictObject({
    tokenId: uint, owner: address.nullable(), token: address.nullable(), status: z.enum(["VERIFIED_POINT_IN_TIME", "NOT_OWNED", "UNSUPPORTED_MANAGED", "READ_FAILED"]),
    principalRaw: uint.nullable(), decimals: z.number().int().min(0).max(36).nullable(), decimalsSource: metadataSource,
    permanent: z.boolean().nullable(), unlockAt: z.iso.datetime().nullable(), source: z.string()
  })).max(16),
  warnings: z.array(z.string())
}).superRefine((value, ctx) => {
  for (const [index, row] of value.liquidBalances.entries()) if (row.status === "VERIFIED_POINT_IN_TIME" && (row.amountRaw === null || row.decimals === null || row.decimalsSource === "UNKNOWN")) {
    ctx.addIssue({ code: "custom", path: ["liquidBalances", index], message: "Verified balance requires raw amount and known units." });
  }
  for (const [index, row] of value.locks.entries()) {
    if (row.status === "VERIFIED_POINT_IN_TIME" && (row.owner === null || row.token === null || row.principalRaw === null || row.decimals === null || row.decimalsSource === "UNKNOWN" || row.permanent === null || (row.permanent ? row.unlockAt !== null : row.unlockAt === null))) {
      ctx.addIssue({ code: "custom", path: ["locks", index], message: "Verified lock requires identity, principal and meaningful units." });
    }
    if (row.status === "NOT_OWNED" && row.owner === null) ctx.addIssue({ code: "custom", path: ["locks", index, "owner"], message: "Not-owned lock requires observed owner." });
  }
  if (value.balancesStatus === "VERIFIED_BOUNDED_SCOPE" && value.liquidBalances.some(row => row.status !== "VERIFIED_POINT_IN_TIME" || row.decimals === null || row.decimalsSource === "UNKNOWN")) {
    ctx.addIssue({ code: "custom", path: ["balancesStatus"], message: "Complete balances cannot contain failed or unknown units." });
  }
  if (value.locksStatus === "VERIFIED_BOUNDED_SCOPE" && value.locks.some(row => !["VERIFIED_POINT_IN_TIME", "NOT_OWNED"].includes(row.status) || (row.status === "VERIFIED_POINT_IN_TIME" && (row.decimals === null || row.decimalsSource === "UNKNOWN")))) {
    ctx.addIssue({ code: "custom", path: ["locksStatus"], message: "Complete locks cannot contain unsupported, failed or unknown-unit rows." });
  }
});
export type WalletAssets = z.infer<typeof walletAssetsSchema>;
