import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  getProtocolStatus,
  getPoolComparison,
  type PoolComparisonInput,
  getWalletSnapshot,
  getVotingPosition,
  getWalletRewards,
  createDefaultRuntime,
  type VotingPositionInput,
  type WalletRewardsInput
} from "./data.js";

import { walletSnapshotSchema, poolComparisonSchema, poolComparisonInputSchema } from "./schema.js";

import { getWalletChanges, getWalletReport, walletChangesSchema, walletChangesInputSchema, walletReportInputSchema, HistoryError, type WalletChangesInput, type WalletReportInput } from "./changes.js";

export type AeroMcpServices = {
  walletReport?: (input: WalletReportInput, signal: AbortSignal) => Promise<Record<string, unknown>>;
  walletChanges?: (signal: AbortSignal, input: WalletChangesInput) => Promise<Record<string, unknown>>;
  poolComparison?: (input: PoolComparisonInput, signal: AbortSignal) => Promise<Record<string, unknown>>;
  walletSnapshot?: (input: WalletRewardsInput, signal: AbortSignal) => Promise<Record<string, unknown>>;
  protocolStatus: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  votingPosition: (input: VotingPositionInput, signal: AbortSignal) => Promise<Record<string, unknown>>;
  walletRewards: (input: WalletRewardsInput, signal: AbortSignal) => Promise<Record<string, unknown>>;
};

const MAX_ACTIVE_READS = 2;
let activeReads = 0;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const tokenIdSchema = z.string()
  .regex(/^\d{1,78}$/)
  .refine((value) => {
    const tokenId = BigInt(value);
    return tokenId > 0n && tokenId < 1n << 256n;
  }, "veNFT tokenId must be a positive uint256");

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function failure(code: "READ_FAILED" | "BUSY" | "CANCELLED" | "DEADLINE" | "HISTORY_BUSY" | "REPORT_NOT_FOUND" | "HISTORY_FULL") {
  const descriptions = {
    HISTORY_BUSY: "Another capture holds this scope lock. Retry with the SAME requestId after it finishes. After a crash, inspect the local lock before recovery.",
    REPORT_NOT_FOUND: "No committed report with this ID exists in the configured scope.",
    HISTORY_FULL: "History reached its retention limit. Export and archive it locally before starting a new history; existing reports remain readable.",
    READ_FAILED: "Read could not be verified. Check local configuration and RPC availability.",
    BUSY: "Two reads are already active. Retry after one finishes.",
    CANCELLED: "Read cancelled.",
    DEADLINE: "Read exceeded its time limit. Narrow the scope and retry."
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Aerodrome ${code}: ${descriptions[code]}` }]
  };
}

export function createAeroMcpServer(services: AeroMcpServices = {
  walletChanges: (signal, input) => getWalletChanges(createDefaultRuntime(signal), undefined, undefined, input),
  walletReport: (input, signal) => getWalletReport(input, createDefaultRuntime(signal)),
  poolComparison: (input, signal) => getPoolComparison(input, createDefaultRuntime(signal)),
  walletSnapshot: (input, signal) => getWalletSnapshot(input, createDefaultRuntime(signal)),
  protocolStatus: (signal) => getProtocolStatus(createDefaultRuntime(signal)),
  votingPosition: (input, signal) => getVotingPosition(input, createDefaultRuntime(signal)),
  walletRewards: (input, signal) => getWalletRewards(input, createDefaultRuntime(signal))
}, options: { deadlineMs?: number } = {}) {
  const deadlineMs = options.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) {
    throw new Error("MCP deadline must be between 1 and 120000 ms.");
  }
  async function execute(requestSignal: AbortSignal, read: (signal: AbortSignal) => Promise<Record<string, unknown>>) {
    if (requestSignal.aborted) return failure("CANCELLED");
    if (activeReads >= MAX_ACTIVE_READS) return failure("BUSY");
    activeReads += 1;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const signal = AbortSignal.any([requestSignal, deadline.signal]);
    try {
      const value = await read(signal);
      signal.throwIfAborted();
      return result(value);
    } catch (error) {
      if (error instanceof HistoryError && !signal.aborted) return failure(error.code);
      // Never echo config parser excerpts, provider text or local paths to a host.
      return failure(requestSignal.aborted ? "CANCELLED" : deadline.signal.aborted ? "DEADLINE" : "READ_FAILED");
    } finally {
      clearTimeout(timer);
      activeReads -= 1;
    }
  }
  const server = new McpServer(
    { name: "aerodrome-readonly", version: "0.1.1" },
    {
      instructions:
        "Base evidence. For changes, generate a UUID requestId before aerodrome_wallet_changes. Reuse that ID for retries; the saved report is immutable. " +
        "Read it again with aerodrome_wallet_report and reportId=requestId, without RPC or baseline updates. A new UUID starts a new comparison. " +
        "For current wallet state use aerodrome_wallet_snapshot. Compare explicit pool addresses with aerodrome_compare_pools. " +
        "Preserve PARTIAL and coverage limits; missing is not zero, reward decreases do not prove income, weights are not yield. " +
        "Report the block interval, changed and unavailable sections, and epoch changes. No signing, broadcasting or profitability proof. " +
        "Never generate a new requestId merely to reformat an answer or recover a lost response. " +
        "BASELINE_CREATED means there is no earlier comparison; zero changes only covers successfully compared fields. " +
        "Use protocol_status for protocol-only questions. Pool comparison is current-state only, not a history of arbitrary selected pools."
    }
  );

  server.registerTool(
    "aerodrome_protocol_status",
    {
      title: "Aerodrome protocol status",
      description: "Verify official configured Aerodrome contracts, Base block, vote totals, pool count, and the current epoch window at one block.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations
    },
    async (_input, ctx) => execute(ctx.mcpReq.signal, (signal) => services.protocolStatus(signal))
  );

  server.registerTool(
    "aerodrome_voting_position",
    {
      title: "Aerodrome voting position",
      description: "Read current veNFT voting power, pool allocations, pool weight shares, gauge liveness, and epoch timing. Uses configured token IDs when none are supplied.",
      inputSchema: z.object({
        tokenIds: z.array(tokenIdSchema).min(1).max(16).optional()
          .describe("Optional public veNFT token IDs; at most 16.")
      }),
      annotations: readOnlyAnnotations
    },
    async (input, ctx) => execute(ctx.mcpReq.signal, (signal) => services.votingPosition(input, signal))
  );

  server.registerTool(
    "aerodrome_wallet_rewards",
    {
      title: "Aerodrome wallet rewards",
      description: "Read claimable voting rewards for configured veNFT current votes and LP rewards for explicitly configured gauges. Historical vote pools are intentionally not scanned.",
      inputSchema: z.object({
        includeZero: z.boolean().optional().default(false),
        maxItems: z.number().int().min(1).max(200).optional().default(100)
      }),
      annotations: readOnlyAnnotations
    },
    async (input, ctx) => execute(ctx.mcpReq.signal, (signal) => services.walletRewards(input, signal))
  );

  server.registerTool(
    "aerodrome_wallet_snapshot",
    {
      title: "Aerodrome coherent wallet snapshot",
      description: "Read protocol, configured veNFT positions and bounded rewards at one Base block, including token display metadata. Recheck the block hash before returning. Preserve PARTIAL status and historical coverage limits.",
      inputSchema: z.strictObject({
        includeZero: z.boolean().optional().default(false),
        maxItems: z.number().int().min(1).max(200).optional().default(100)
      }),
      outputSchema: walletSnapshotSchema,
      annotations: readOnlyAnnotations
    },
    async (input, ctx) => execute(ctx.mcpReq.signal, async (signal) => {
      if (!services.walletSnapshot) throw new Error("Snapshot service unavailable.");
      return walletSnapshotSchema.parse(await services.walletSnapshot(input, signal));
    })
  );

  server.registerTool(
    "aerodrome_compare_pools",
    {
      title: "Compare selected Aerodrome pools",
      description: "Compare 2–16 distinct pool addresses using official Voter weights, protocol weight shares, gauge registration/liveness and reward contract addresses at one Base block. Preserves input order. Unknown data stays null; no yield, liquidity or profitability ranking.",
      inputSchema: poolComparisonInputSchema,
      outputSchema: poolComparisonSchema,
      annotations: readOnlyAnnotations
    },
    async (input, ctx) => execute(ctx.mcpReq.signal, async (signal) => {
      if (!services.poolComparison) throw new Error("Pool comparison service unavailable.");
      return poolComparisonSchema.parse(await services.poolComparison(input, signal));
    })
  );

  server.registerTool("aerodrome_wallet_changes", {
    title: "Wallet changes since last complete snapshot",
    description: "Capture a new configured-wallet comparison using a caller-generated UUID requestId. Reuse the SAME ID for retries: returns the saved report without RPC. A new ID advances the baseline only for a complete snapshot. Report and baseline commit atomically; partial reports are saved without replacing the baseline. This tool writes local history but never changes blockchain state. Missing reward rows are unknown, not zero or proof of claims.",
    inputSchema: walletChangesInputSchema, outputSchema: walletChangesSchema,
    annotations: { ...readOnlyAnnotations, readOnlyHint: false, idempotentHint: true }
  }, async (input, ctx) => execute(ctx.mcpReq.signal, async signal => {
    if (!services.walletChanges) throw new Error("Changes service unavailable.");
    return walletChangesSchema.parse(await services.walletChanges(signal, input));
  }));

  server.registerTool("aerodrome_wallet_report", {
    title: "Read a saved wallet change report",
    description: "Retrieve a committed report by reportId (the original requestId) within the configured wallet scope. No RPC, capture or baseline change. Available after restart and while another capture is running.",
    inputSchema: walletReportInputSchema, outputSchema: walletChangesSchema,
    annotations: { ...readOnlyAnnotations, openWorldHint: false }
  }, async (input, ctx) => execute(ctx.mcpReq.signal, async signal => {
    if (!services.walletReport) throw new Error("Report service unavailable.");
    return walletChangesSchema.parse(await services.walletReport(input, signal));
  }));

  return server;
}
