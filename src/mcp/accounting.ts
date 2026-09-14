import { decodeEventLog, formatUnits, getAddress, isAddress, parseAbi, type Address } from "viem";
import * as z from "zod/v4";
import { voterAbi, veAbi } from "../abi.js";
import { walletAddress, voterAddress, zeroAddress } from "../config.js";
import { getTokenMeta } from "../tokens.js";
import { getWalletAssets } from "./assets.js";
import { walletAssetsSchema } from "./assets-schema.js";
import { createDefaultRuntime, observation, type ToolRuntime } from "./data.js";

const addr = z.string().refine(x => isAddress(x) && x.toLowerCase() !== zeroAddress());
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(x => BigInt(x) < 1n << 256n);
const hash = z.string().regex(/^0x[\da-fA-F]{64}$/);
const ids = z.array(uint.refine(x => BigInt(x) > 0n)).max(16).refine(x => new Set(x).size === x.length);
export const accountingInputSchema = z.strictObject({
  wallet: addr.optional(),
  fromBlock: uint.describe("Inclusive first Base block to inspect. History is paginated by block, not inferred from snapshots."),
  toBlock: uint.optional().describe("Fixed inclusive end block; defaults to current Base block. Reuse returned toBlock across pages."),
  blockSpan: z.number().int().min(1).max(10000).optional().default(2000),
  tokenIds: ids.optional().describe("Selected veNFT IDs for rebase history and current locks. Defaults to local IDs only for the configured wallet. Historical ownership is verified before rebase totals."),
  pools: z.array(addr).max(8).refine(x => new Set(x.map(a => a.toLowerCase())).size === x.length).optional().default([])
    .describe("Explicit historical voting pools. Only fee/bribe reward contracts verified through Voter mappings at the end block are scanned; omitted pools are not zero rewards.")
});
export type AccountingInput = z.input<typeof accountingInputSchema>;
const category = z.enum(["WALLET_DEPOSIT", "WALLET_WITHDRAWAL", "VOTING_REWARD_RECEIVED", "REBASE_RECEIVED", "SELECTED_POSITION_REBASE_LOCKED", "UNVERIFIED_EVENT"]);
export const accountingEventSchema = z.strictObject({
  id: z.string(), category, status: z.enum(["RECEIPT_VERIFIED", "UNVERIFIED"]),
  eventName: z.string(), contract: addr, token: addr, tokenId: uint.nullable(),
  amountRaw: uint, blockNumber: uint, blockHash: hash, transactionHash: hash,
  logIndex: z.number().int().nonnegative(), transferLogIndex: z.number().int().nonnegative().nullable(),
  source: z.string().url(), attribution: z.string()
});
export const accountingSchema = z.strictObject({
  status: z.enum(["VERIFIED_BOUNDED_SCOPE", "PARTIAL_BOUNDED_SCOPE"]), readOnly: z.literal(true), chainId: z.literal(8453), wallet: addr,
  observation: walletAssetsSchema.shape.observation,
  scope: z.strictObject({ tokenIds: ids, pools: z.array(addr), votingEscrow: addr, escrowToken: addr, distributor: addr.nullable() }),
  page: z.strictObject({ fromBlock: uint, scannedToBlock: uint, toBlock: uint, nextFromBlock: uint.nullable(),
    status: z.enum(["COMPLETE", "PARTIAL"]), retryFromBlock: uint.nullable(), logLimit: z.literal(500), receiptLimit: z.literal(32) }),
  sources: z.array(z.strictObject({ contract: addr, eventName: z.string(), status: z.enum(["SCANNED", "READ_FAILED"]), eventCount: z.number().int().nonnegative() })),
  events: z.array(accountingEventSchema).max(500),
  totals: z.array(z.strictObject({ category, token: addr, amountRaw: uint, amountFormatted: z.string().nullable(),
    symbol: z.string(), decimals: z.number().int().min(0).max(36).nullable(), eventIds: z.array(z.string()),
    status: z.enum(["VERIFIED_PAGE_SUM", "PARTIAL_PAGE_SUM"]) })),
  currentHoldings: walletAssetsSchema.nullable(),
  reconciliation: z.strictObject({ status: z.literal("UNKNOWN"), netProfitUsd: z.null(), reason: z.string() }),
  warnings: z.array(z.string()), summary: z.array(z.string())
});

// Exact event layouts from aerodrome-finance/contracts interfaces IVotingEscrow,
// IReward and IRewardsDistributor. Transfer events alone never establish rewards.
export const accountingAbi = parseAbi([
  "event Deposit(address indexed provider,uint256 indexed tokenId,uint8 indexed depositType,uint256 value,uint256 locktime,uint256 ts)",
  "event Withdraw(address indexed provider,uint256 indexed tokenId,uint256 value,uint256 ts)",
  "event ClaimRewards(address indexed from,address indexed reward,uint256 amount)",
  "event Claimed(uint256 indexed tokenId,uint256 indexed epochStart,uint256 indexed epochEnd,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function distributor() view returns (address)"
]);
const ownershipTransferEvent = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"])[0];
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function nonzero(x: unknown): Address { return getAddress(addr.parse(x)); }
function raw(x: unknown): bigint { if (typeof x !== "bigint" || x < 0n || x >= 1n << 256n) throw Error("Invalid amount"); return x; }
function decode(log: any) { return decodeEventLog({ abi: accountingAbi, data: log.data, topics: log.topics, strict: true }) as { eventName: string; args: Record<string, any> }; }
type Candidate = { log: any; event: ReturnType<typeof decode>; contract: Address };

/** Receipt-backed, bounded protocol cash flows. No indexer, prices, wallet signer or disk writes. */
export async function getWalletAccounting(input: AccountingInput, runtime: ToolRuntime = createDefaultRuntime()) {
  const args = accountingInputSchema.parse(input);
  runtime.signal?.throwIfAborted();
  const wallet = args.wallet ? getAddress(args.wallet) : walletAddress(runtime.cfg);
  const client = runtime.client;
  if (await client.getChainId() !== 8453) throw Error("Wrong chain");
  const latest = await observation(client);
  const end = args.toBlock === undefined ? latest.rawBlockNumber : BigInt(args.toBlock);
  const start = BigInt(args.fromBlock);
  if (end > latest.rawBlockNumber || start > end) throw Error("Invalid block range");
  const block = await client.getBlock({ blockNumber: end });
  if (block.number !== end || !hash.safeParse(block.hash).success || typeof block.timestamp !== "bigint") throw Error("Invalid end block");
  const pinned = { rawBlockNumber: end, rawTimestamp: block.timestamp, value: { observedAt: latest.value.observedAt,
    blockNumber: end.toString(), blockHash: block.hash as string, blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString() } };
  const stop = start + BigInt(args.blockSpan) - 1n < end ? start + BigInt(args.blockSpan) - 1n : end;
  const voter = voterAddress(runtime.cfg);
  const read = (address: Address, abi: any, functionName: string, values?: any[]) => client.readContract({ address, abi, functionName, args: values, blockNumber: end });
  const ve = nonzero(await read(voter, voterAbi, "ve"));
  const token = nonzero(await read(ve, veAbi, "token"));
  const tokenIds = args.tokenIds ?? (same(runtime.cfg.walletAddress, wallet) ? runtime.cfg.veNftTokenIds : []);
  ids.parse(tokenIds);
  let partial = false;
  let pagePartial = false;
  const warnings: string[] = [];
  const fail = (message: string, page = true) => { runtime.signal?.throwIfAborted(); partial = true; if (page) pagePartial = true; warnings.push(message); };
  let distributor: Address | null = null;
  if (tokenIds.length) try { distributor = nonzero(await read(ve, accountingAbi, "distributor")); } catch { fail("Distributor could not be verified; selected-position rebases are unavailable."); }
  const plans: { contract: Address; eventName: string; filter: any }[] = [
    { contract: ve, eventName: "Deposit", filter: { provider: wallet } },
    { contract: ve, eventName: "Withdraw", filter: { provider: wallet } }
  ];
  if (distributor) plans.push({ contract: distributor, eventName: "Claimed", filter: { tokenId: tokenIds.map(BigInt) } });
  const rewardContracts = new Set<string>();
  for (const pool of args.pools) {
    runtime.signal?.throwIfAborted();
    try {
      const gauge = nonzero(await read(voter, voterAbi, "gauges", [getAddress(pool)]));
      if (await read(voter, voterAbi, "isGauge", [gauge]) !== true) throw Error("Unknown gauge");
      for (const name of ["gaugeToFees", "gaugeToBribe"]) {
        const reward = nonzero(await read(voter, voterAbi, name, [gauge]));
        if (!rewardContracts.has(reward.toLowerCase())) {
          rewardContracts.add(reward.toLowerCase());
          plans.push({ contract: reward, eventName: "ClaimRewards", filter: { from: wallet } });
        }
      }
    } catch { fail(`Voting reward sources could not be fully verified for pool ${pool}.`); }
  }
  const sources: z.infer<typeof accountingSchema>["sources"] = [];
  const candidates = new Map<string, Candidate>();
  for (const plan of plans) {
    runtime.signal?.throwIfAborted();
    try {
      const event = accountingAbi.find(x => x.type === "event" && x.name === plan.eventName);
      const logs = await client.getLogs({ address: plan.contract, event, args: plan.filter, fromBlock: start, toBlock: stop, strict: true });
      if (!Array.isArray(logs) || logs.length > 500) throw Error("Log cap");
      const staged = new Map<string, Candidate>();
      for (const log of logs) {
        if (!same(log.address, plan.contract) || log.removed || typeof log.blockNumber !== "bigint" || log.blockNumber < start || log.blockNumber > stop ||
          !hash.safeParse(log.blockHash).success || !hash.safeParse(log.transactionHash).success || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw Error("Invalid log");
        const decoded = decode(log);
        if (decoded.eventName !== plan.eventName) throw Error("Wrong event");
        // Do not rely solely on a provider applying the filter correctly.
        if (decoded.eventName === "Claimed" ? !tokenIds.includes(String(decoded.args.tokenId)) : !same(decoded.args.provider ?? decoded.args.from, wallet)) throw Error("Wrong account");
        raw(decoded.args.value ?? decoded.args.amount);
        const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
        const previous = staged.get(id) ?? candidates.get(id);
        if (previous && (JSON.stringify(previous.log.topics) !== JSON.stringify(log.topics) || previous.log.data !== log.data || previous.log.blockHash !== log.blockHash || !same(previous.contract, plan.contract))) throw Error("Conflicting duplicate");
        staged.set(id, { log, event: decoded, contract: plan.contract });
      }
      if (new Set([...candidates.keys(), ...staged.keys()]).size > 500) throw Error("Total log cap");
      for (const [id, row] of staged) candidates.set(id, row);
      sources.push({ contract: plan.contract, eventName: plan.eventName, status: "SCANNED", eventCount: staged.size });
    } catch { fail(`Log scan unavailable or exceeded limits for ${plan.eventName} at ${plan.contract}; narrow blockSpan and retry this page.`); sources.push({ contract: plan.contract, eventName: plan.eventName, status: "READ_FAILED", eventCount: 0 }); }
  }
  const sorted = [...candidates.entries()].sort((a, b) => a[1].log.blockNumber === b[1].log.blockNumber ? a[1].log.logIndex - b[1].log.logIndex : a[1].log.blockNumber < b[1].log.blockNumber ? -1 : 1);
  const receipts = new Map<string, any>();
  const receiptBlocks = new Map<string, string>();
  const usedTransfers = new Set<string>();
  const ownershipProofs = new Map<string, boolean>();
  async function walletOwnedThroughoutBlock(tokenId: bigint, eventBlock: bigint): Promise<void> {
    const key = `${tokenId}:${eventBlock}`;
    if (!ownershipProofs.has(key)) {
      ownershipProofs.set(key, false);
      if (eventBlock === 0n) throw Error("No prior ownership block");
      const before = await client.readContract({ address: ve, abi: veAbi, functionName: "ownerOf", args: [tokenId], blockNumber: eventBlock - 1n });
      const after = await client.readContract({ address: ve, abi: veAbi, functionName: "ownerOf", args: [tokenId], blockNumber: eventBlock });
      if (!same(before, wallet) || !same(after, wallet)) throw Error("Historical owner differs");
      // Equal owners at block boundaries alone miss transfers away and back.
      // Conservatively exclude any ownership movement (including mint) in this block.
      const transfers = await client.getLogs({ address: ve, event: ownershipTransferEvent, args: { tokenId }, fromBlock: eventBlock, toBlock: eventBlock, strict: true });
      if (!Array.isArray(transfers) || transfers.length !== 0) throw Error("Ambiguous intra-block ownership");
      runtime.signal?.throwIfAborted();
      ownershipProofs.set(key, true);
    }
    if (!ownershipProofs.get(key)) throw Error("Historical ownership unverified");
  }
  const events: z.infer<typeof accountingEventSchema>[] = [];
  for (const [id, c] of sorted) {
    const { log, event } = c;
    const value = raw(event.args.value ?? event.args.amount);
    const rewardToken = event.eventName === "ClaimRewards" ? nonzero(event.args.reward) : token;
    const row: z.infer<typeof accountingEventSchema> = { id, category: "UNVERIFIED_EVENT", status: "UNVERIFIED", eventName: event.eventName,
      contract: c.contract, token: rewardToken, tokenId: event.args.tokenId?.toString() ?? null, amountRaw: value.toString(), blockNumber: log.blockNumber.toString(),
      blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex, transferLogIndex: null,
      source: `https://basescan.org/tx/${log.transactionHash}#eventlog`, attribution: "Not included in totals until receipt and matching token transfer are verified." };
    try {
      runtime.signal?.throwIfAborted();
      const txKey = log.transactionHash.toLowerCase();
      if (!receipts.has(txKey)) {
        if (receipts.size >= 32) throw Error("Receipt limit");
        receipts.set(txKey, null); // Failed reads consume the cap; no repeated retries.
        const r = await client.getTransactionReceipt({ hash: log.transactionHash });
        if (r.status !== "success" || !same(r.transactionHash, log.transactionHash) || r.blockNumber !== log.blockNumber || r.blockHash !== log.blockHash || !Array.isArray(r.logs) || r.logs.length > 2000) throw Error("Invalid receipt");
        if (!receiptBlocks.has(log.blockNumber.toString())) {
          const canonical = await client.getBlock({ blockNumber: log.blockNumber });
          receiptBlocks.set(log.blockNumber.toString(), hash.parse(canonical.hash));
        }
        if (receiptBlocks.get(log.blockNumber.toString()) !== log.blockHash) throw Error("Non-canonical receipt");
        receipts.set(txKey, r);
      }
      const receipt = receipts.get(txKey);
      if (!receipt || receipt.blockHash !== log.blockHash || !receipt.logs.some((l: any) => l.logIndex === log.logIndex && same(l.address, c.contract) && l.data === log.data && JSON.stringify(l.topics) === JSON.stringify(log.topics))) throw Error("Event missing from receipt");
      let from: string = wallet, to: string = ve;
      let kind: z.infer<typeof category> = "WALLET_DEPOSIT";
      if (event.eventName === "Withdraw") { from = ve; to = wallet; kind = "WALLET_WITHDRAWAL"; }
      if (event.eventName === "ClaimRewards") { from = c.contract; to = wallet; kind = "VOTING_REWARD_RECEIVED"; }
      if (event.eventName === "Claimed") {
        await walletOwnedThroughoutBlock(raw(event.args.tokenId), log.blockNumber);
        from = c.contract;
        const credited = receipt.logs.some((l: any) => {
          if (!same(l.address, ve)) return false;
          try { const e = decode(l); return e.eventName === "Deposit" && same(e.args.provider, c.contract) && e.args.tokenId === event.args.tokenId && e.args.value === value; } catch { return false; }
        });
        to = credited ? ve : wallet;
        kind = credited ? "SELECTED_POSITION_REBASE_LOCKED" : "REBASE_RECEIVED";
      }
      if (value === 0n) {
        row.category = kind; row.status = "RECEIPT_VERIFIED"; row.attribution = "Zero-value protocol event; no cash movement.";
      } else {
        const transfer = receipt.logs.find((l: any) => {
          const key = `${txKey}:${l.logIndex}`;
          if (!same(l.address, rewardToken) || !Number.isSafeInteger(l.logIndex) || usedTransfers.has(key)) return false;
          try { const e = decode(l); return e.eventName === "Transfer" && same(e.args.from, from) && same(e.args.to, to) && e.args.value === value; } catch { return false; }
        });
        if (!transfer) throw Error("Matching token transfer unavailable");
        usedTransfers.add(`${txKey}:${transfer.logIndex}`);
        row.category = kind; row.status = "RECEIPT_VERIFIED"; row.transferLogIndex = transfer.logIndex;
        row.attribution = kind === "SELECTED_POSITION_REBASE_LOCKED" ? "Credit to selected veNFT principal owned by this wallet throughout the event block; not liquid wallet income." :
          kind === "WALLET_DEPOSIT" ? "Paid by this wallet into escrow, possibly for a different owner's NFT; not a token purchase cost basis." : "Matching ERC-20 transfer to this wallet in a successful protocol receipt; gross token amount, not USD profit.";
      }
    } catch { fail(`Receipt or cash-flow match unavailable for event ${id}; excluded from totals.`); }
    events.push(row);
  }
  const amounts = new Map<string, { category: z.infer<typeof category>; token: string; amount: bigint; eventIds: string[] }>();
  for (const e of events) if (e.status === "RECEIPT_VERIFIED") {
    const key = `${e.category}:${e.token.toLowerCase()}`;
    const a = amounts.get(key) ?? { category: e.category, token: e.token, amount: 0n, eventIds: [] };
    a.amount += BigInt(e.amountRaw); a.eventIds.push(e.id); amounts.set(key, a);
  }
  const totals: z.infer<typeof accountingSchema>["totals"] = [];
  const meta = new Map<string, Awaited<ReturnType<typeof getTokenMeta>> | null>();
  for (const a of amounts.values()) {
    if (!meta.has(a.token)) {
      let m = null;
      if (meta.size < 16) try { m = await getTokenMeta(client, getAddress(a.token), undefined, end); } catch { /* raw amounts remain valid */ }
      meta.set(a.token, m);
    }
    const m = meta.get(a.token);
    const decimals = m && m.decimalsSource !== "ASSUMED" ? m.decimals : null;
    if (decimals === null) fail(`Display metadata unavailable for ${a.token}; use raw units.`, false);
    totals.push({ category: a.category, token: a.token, amountRaw: a.amount.toString(), amountFormatted: decimals === null ? null : formatUnits(a.amount, decimals),
      symbol: m?.symbol ?? a.token, decimals, eventIds: a.eventIds, status: pagePartial ? "PARTIAL_PAGE_SUM" : "VERIFIED_PAGE_SUM" });
  }
  let currentHoldings: z.infer<typeof walletAssetsSchema> | null = null;
  try {
    currentHoldings = await getWalletAssets({ ...runtime, pinnedObservation: pinned, cfg: { ...runtime.cfg, walletAddress: wallet, veNftTokenIds: tokenIds } }, { contracts: { votingEscrow: ve } });
    if (currentHoldings.balancesStatus.startsWith("PARTIAL") || currentHoldings.locksStatus.startsWith("PARTIAL")) fail("Some end-block holdings are unavailable.", false);
  } catch { fail("End-block holdings are unavailable; no remainder was inferred from flows.", false); }
  const finalBlock = await client.getBlock({ blockNumber: end });
  runtime.signal?.throwIfAborted();
  if (finalBlock.number !== end || finalBlock.hash !== pinned.value.blockHash) throw Error("End block changed during reads");
  const next = stop < end ? (stop + 1n).toString() : null;
  return accountingSchema.parse({ status: partial || next !== null ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE", readOnly: true, chainId: 8453, wallet,
    observation: pinned.value, scope: { tokenIds, pools: args.pools, votingEscrow: ve, escrowToken: token, distributor },
    page: { fromBlock: start.toString(), scannedToBlock: stop.toString(), toBlock: end.toString(), nextFromBlock: pagePartial ? null : next,
      status: pagePartial ? "PARTIAL" : "COMPLETE", retryFromBlock: pagePartial ? start.toString() : null, logLimit: 500, receiptLimit: 32 },
    sources, events, totals, currentHoldings,
    reconciliation: { status: "UNKNOWN", netProfitUsd: null, reason: "Windowed protocol flows and end-block holdings are independent. Opening balances, historical NFT ownership, NFT transfers/splits/merges, other wallet transfers, swaps, LP principal, third-party vaults, gas and cost basis are not reconciled. Do not sum holdings across pages or call gross receipts net profit." },
    warnings: [...warnings, "Only explicit voting pools and selected veNFT IDs are covered. Omitted pools/IDs and unavailable reads are unknown, not zero.",
      "Reward contracts and distributor are resolved at toBlock; replaced historical sources are not discovered. RPC log completeness and canonical-chain responses are trusted.",
      "Transfer events establish reported gross movement, not economic value, sellability, or exact net balance changes for non-standard tokens.",
      "Rebases require this wallet to own the veNFT before and after the event block, with no ownership transfers in that block; unavailable history or same-block mint/transfer is excluded. Current holdings include ETH/AERO/USDC and selected normal locks only."],
    summary: [`Protocol cash-flow page: blocks ${start}–${stop}; holdings independently read at block ${end}.`,
      `${events.filter(e => e.status === "RECEIPT_VERIFIED").length} receipt-verified events; ${events.filter(e => e.status !== "RECEIPT_VERIFIED").length} excluded events.`,
      ...totals.map(a => `${a.category}: ${a.amountFormatted ?? a.amountRaw + " raw units"} ${a.symbol} (${a.token}).`),
      ...(pagePartial ? ["Retry this block page with a narrower span; do not treat missing events as zero."] : next ? [`Continue with fromBlock=${next} and the same toBlock=${end}, wallet, tokenIds and pools.`] : ["Selected block window scanned; this does not establish lifetime wallet coverage."]),
      "Locked rebases, wallet receipts and current holdings are separate. Net profit is unknown."] });
}
