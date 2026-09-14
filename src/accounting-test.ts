import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address } from "viem";
import type { AppConfig } from "./types.js";
import { accountingAbi, accountingSchema, getWalletAccounting } from "./mcp/accounting.js";
import { createAeroMcpServer } from "./mcp/server.js";

const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as Address;
const VE = "0x0000000000000000000000000000000000000001" as Address;
const WALLET = "0x0000000000000000000000000000000000000002" as Address;
const FOREIGN = "0x0000000000000000000000000000000000000003" as Address;
const POOL = "0x0000000000000000000000000000000000000004" as Address;
const GAUGE = "0x0000000000000000000000000000000000000005" as Address;
const BRIBE = "0x0000000000000000000000000000000000000006" as Address;
const FEES = "0x0000000000000000000000000000000000000007" as Address;
const TOKEN = "0x0000000000000000000000000000000000000008" as Address;
const REWARD = "0x0000000000000000000000000000000000000009" as Address;
const DISTRIBUTOR = "0x000000000000000000000000000000000000000a" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const END = 110n;
const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const ALT_HASH = `0x${"cd".repeat(32)}` as `0x${string}`;
const erc721TransferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);

type RawLog = Record<string, any>;

function config(wallet = WALLET): AppConfig {
  return {
    walletAddress: wallet,
    baseRpcUrl: "https://example.invalid",
    contracts: { voter: VOTER, router: VOTER, defaultFactory: VOTER },
    tokens: { USDC: REWARD },
    veNftTokenIds: ["1"],
    gaugeAddresses: []
  };
}

function tx(hex: string) { return `0x${hex.repeat(64)}` as `0x${string}`; }

function dataFor(name: string, amount: bigint) {
  if (name === "Deposit") return encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }
  ], [amount, 0n, 1_700_000_000n]);
  if (name === "Withdraw") return encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }
  ], [amount, 1_700_000_000n]);
  return encodeAbiParameters([{ type: "uint256" }], [amount]);
}

function log(name: string, address: Address, blockNumber: bigint, logIndex: number, transactionHash: `0x${string}`, amount: bigint, indexed: Record<string, unknown>): RawLog {
  return {
    address,
    blockNumber,
    blockHash: HASH,
    transactionHash,
    logIndex,
    removed: false,
    topics: encodeEventTopics({ abi: accountingAbi, eventName: name as any, args: indexed as any }),
    data: dataFor(name, amount)
  };
}

function transfer(from: Address, to: Address, amount: bigint, blockNumber: bigint, logIndex: number, transactionHash: `0x${string}`, token = TOKEN) {
  return log("Transfer", token, blockNumber, logIndex, transactionHash, amount, { from, to });
}

function nftTransfer(from: Address, to: Address, tokenId: bigint, blockNumber: bigint, logIndex: number, transactionHash: `0x${string}`): RawLog {
  return {
    address: VE, blockNumber, blockHash: HASH, transactionHash, logIndex, removed: false,
    topics: encodeEventTopics({ abi: erc721TransferAbi, eventName: "Transfer", args: { from, to, tokenId } }), data: "0x"
  };
}

type FixtureOptions = {
  logs?: RawLog[];
  receiptLogs?: Map<string, RawLog[]>;
  failLogs?: Set<string>;
  metadataUnknown?: boolean;
  reorgAtEnd?: boolean;
  historicOwnerBefore?: Address;
  currentOwner?: Address;
  nftTransferred?: boolean;
  ownerHistoryUnavailable?: boolean;
};

function runtime(options: FixtureOptions = {}) {
  let endReads = 0;
  const logs = options.logs ?? [];
  const receiptLogs = options.receiptLogs ?? new Map(logs.map((row) => [row.transactionHash.toLowerCase(), [row]]));
  const client = {
    getChainId: async () => 8453,
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
      if (blockTag === "latest") return { number: END, timestamp: 1_700_000_110n, hash: HASH };
      if (blockNumber === END) {
        endReads += 1;
        return { number: END, timestamp: 1_700_000_110n, hash: options.reorgAtEnd && endReads > 1 ? ALT_HASH : HASH };
      }
      return { number: blockNumber, timestamp: 1_700_000_000n, hash: HASH };
    },
    getLogs: async (input: any) => {
      const name = input.event?.name;
      const key = `${input.address.toLowerCase()}:${name}`;
      if (options.failLogs?.has(key)) throw new Error("synthetic RPC failure");
      if (input.address.toLowerCase() === VE.toLowerCase() && name === "Transfer") {
        return options.nftTransferred ? [nftTransfer(WALLET, FOREIGN, 1n, 105n, 9, tx("f"))] : [];
      }
      return logs.filter((row) =>
        row.address.toLowerCase() === input.address.toLowerCase() &&
        row.blockNumber >= input.fromBlock && row.blockNumber <= input.toBlock &&
        (() => {
          try { return (input.event?.name ?? "") === (nameFor(row) ?? ""); } catch { return false; }
        })()
      );
    },
    getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => ({
      status: "success",
      transactionHash: hash,
      blockNumber: (receiptLogs.get(hash.toLowerCase()) ?? [])[0]?.blockNumber ?? 101n,
      blockHash: HASH,
      logs: receiptLogs.get(hash.toLowerCase()) ?? []
    }),
    getBalance: async () => 0n,
    readContract: async (call: any) => {
      switch (call.functionName) {
        case "ve": return VE;
        case "token": return TOKEN;
        case "distributor": return DISTRIBUTOR;
        case "gauges": return GAUGE;
        case "isGauge": return true;
        case "gaugeToBribe": return BRIBE;
        case "gaugeToFees": return FEES;
        case "balanceOf": return 50n;
        case "ownerOf": {
          if (options.ownerHistoryUnavailable && call.blockNumber < END) throw new Error("historical owner unavailable");
          if (call.blockNumber === 104n) return options.historicOwnerBefore ?? WALLET;
          return options.currentOwner ?? WALLET;
        }
        case "escrowType": return 0;
        case "locked": return { amount: 50n, end: 1_800_000_000n, isPermanent: false };
        case "symbol": if (options.metadataUnknown) throw new Error("metadata absent"); return "AERO";
        case "decimals": if (options.metadataUnknown) throw new Error("metadata absent"); return 18;
        default: throw new Error(`Unexpected synthetic read: ${call.functionName}`);
      }
    }
  };
  return { cfg: config(), client } as any;
}

function nameFor(row: RawLog) {
  // Event signatures are sufficient for fixture routing; the implementation performs strict decode itself.
  const deposit = encodeEventTopics({ abi: accountingAbi, eventName: "Deposit", args: { provider: WALLET, tokenId: 1n, depositType: 0 } })[0];
  const withdraw = encodeEventTopics({ abi: accountingAbi, eventName: "Withdraw", args: { provider: WALLET, tokenId: 1n } })[0];
  const claim = encodeEventTopics({ abi: accountingAbi, eventName: "ClaimRewards", args: { from: WALLET, reward: REWARD } })[0];
  const claimed = encodeEventTopics({ abi: accountingAbi, eventName: "Claimed", args: { tokenId: 1n, epochStart: 1n, epochEnd: 2n } })[0];
  return row.topics[0] === deposit ? "Deposit" : row.topics[0] === withdraw ? "Withdraw" : row.topics[0] === claim ? "ClaimRewards" : row.topics[0] === claimed ? "Claimed" : "Transfer";
}

function accounting(input: Record<string, unknown>, options: FixtureOptions = {}) {
  return getWalletAccounting({ fromBlock: "100", toBlock: END.toString(), ...input } as any, runtime(options));
}

async function testReceiptTotalsAndCurrentHoldings() {
  const depositTx = tx("1"), withdrawTx = tx("2"), rewardTx = tx("3");
  const deposit = log("Deposit", VE, 101n, 0, depositTx, 20n, { provider: WALLET, tokenId: 1n, depositType: 0 });
  const withdrawal = log("Withdraw", VE, 102n, 0, withdrawTx, 7n, { provider: WALLET, tokenId: 1n });
  const reward = log("ClaimRewards", BRIBE, 103n, 0, rewardTx, 9n, { from: WALLET, reward: REWARD });
  const result = accountingSchema.parse(await accounting({ pools: [POOL] }, {
    logs: [deposit, withdrawal, reward],
    receiptLogs: new Map([
      [depositTx.toLowerCase(), [deposit, transfer(WALLET, VE, 20n, 101n, 1, depositTx)]],
      [withdrawTx.toLowerCase(), [withdrawal, transfer(VE, WALLET, 7n, 102n, 1, withdrawTx)]],
      [rewardTx.toLowerCase(), [reward, transfer(BRIBE, WALLET, 9n, 103n, 1, rewardTx, REWARD)]]
    ])
  }));
  assert.deepEqual(result.events.map((event) => event.category), ["WALLET_DEPOSIT", "WALLET_WITHDRAWAL", "VOTING_REWARD_RECEIVED"]);
  assert.ok(result.events.every((event) => event.status === "RECEIPT_VERIFIED"));
  assert.deepEqual(result.totals.map((total) => [total.category, total.amountRaw]), [
    ["WALLET_DEPOSIT", "20"], ["WALLET_WITHDRAWAL", "7"], ["VOTING_REWARD_RECEIVED", "9"]
  ]);
  assert.equal(result.currentHoldings?.liquidBalances.find((row) => row.token?.toLowerCase() === TOKEN.toLowerCase())?.amountRaw, "50");
  assert.equal(result.reconciliation.status, "UNKNOWN");
}

async function testSpoofedReceiptIsExcluded() {
  const receiptTx = tx("4");
  const reward = log("ClaimRewards", BRIBE, 104n, 0, receiptTx, 9n, { from: WALLET, reward: REWARD });
  const result = await accounting({ pools: [POOL] }, {
    logs: [reward],
    receiptLogs: new Map([
      [receiptTx.toLowerCase(), [reward, transfer(FEES, WALLET, 9n, 104n, 1, receiptTx, REWARD)]]
    ])
  });
  assert.equal(result.events[0].status, "UNVERIFIED");
  assert.equal(result.events[0].category, "UNVERIFIED_EVENT");
  assert.equal(result.totals.some((total) => total.category === "VOTING_REWARD_RECEIVED"), false);
}

async function testLockedRebaseIsSeparateFromLiquidHoldings() {
  const rebaseTx = tx("5");
  const claimed = log("Claimed", DISTRIBUTOR, 105n, 0, rebaseTx, 5n, { tokenId: 1n, epochStart: 1n, epochEnd: 2n });
  const credit = log("Deposit", VE, 105n, 1, rebaseTx, 5n, { provider: DISTRIBUTOR, tokenId: 1n, depositType: 0 });
  const result = await accounting({}, {
    logs: [claimed],
    receiptLogs: new Map([[rebaseTx.toLowerCase(), [claimed, credit, transfer(DISTRIBUTOR, VE, 5n, 105n, 2, rebaseTx)]]])
  });
  assert.equal(result.events[0].category, "SELECTED_POSITION_REBASE_LOCKED");
  assert.equal(result.events[0].status, "RECEIPT_VERIFIED");
  assert.equal(result.totals[0].amountRaw, "5");
  assert.equal(result.currentHoldings?.locks[0]?.principalRaw, "50");
  assert.equal(result.events.some((event) => event.category === "REBASE_RECEIVED"), false);
}

async function testClaimedRequiresContinuousWalletOwnership() {
  const claimTx = tx("a");
  const claimed = log("Claimed", DISTRIBUTOR, 105n, 0, claimTx, 5n, { tokenId: 1n, epochStart: 1n, epochEnd: 2n });
  const credit = log("Deposit", VE, 105n, 1, claimTx, 5n, { provider: DISTRIBUTOR, tokenId: 1n, depositType: 0 });
  const fixture = (options: FixtureOptions = {}): FixtureOptions => ({
    ...options,
    logs: [claimed],
    receiptLogs: new Map([
      [claimTx.toLowerCase(), [claimed, credit, transfer(DISTRIBUTOR, VE, 5n, 105n, 2, claimTx)]]
    ])
  });
  const assertExcluded = (result: Awaited<ReturnType<typeof getWalletAccounting>>) => {
    assert.equal(result.events[0]?.status, "UNVERIFIED");
    assert.equal(result.events[0]?.category, "UNVERIFIED_EVENT");
    assert.equal(result.totals.some((row) => row.category === "SELECTED_POSITION_REBASE_LOCKED" || row.category === "REBASE_RECEIVED"), false);
  };

  await assertExcluded(await getWalletAccounting({ wallet: FOREIGN, tokenIds: ["1"], fromBlock: "100", toBlock: "110" }, runtime(fixture())));
  await assertExcluded(await accounting({}, fixture({ nftTransferred: true })));
  await assertExcluded(await accounting({}, fixture({ historicOwnerBefore: FOREIGN, currentOwner: WALLET })));
  await assertExcluded(await accounting({}, fixture({ ownerHistoryUnavailable: true })));
}

async function testLiquidRebaseAndLogIdentityGuards() {
  const rebaseTx = tx("7");
  const liquid = log("Claimed", DISTRIBUTOR, 106n, 0, rebaseTx, 4n, { tokenId: 1n, epochStart: 1n, epochEnd: 2n });
  const liquidResult = await accounting({}, {
    logs: [liquid],
    receiptLogs: new Map([
      [rebaseTx.toLowerCase(), [liquid, transfer(DISTRIBUTOR, WALLET, 4n, 106n, 1, rebaseTx)]]
    ])
  });
  assert.equal(liquidResult.events[0].category, "REBASE_RECEIVED");
  assert.equal(liquidResult.events[0].status, "RECEIPT_VERIFIED");

  const duplicateTx = tx("8");
  const first = log("Deposit", VE, 107n, 0, duplicateTx, 5n, { provider: WALLET, tokenId: 1n, depositType: 0 });
  const second = log("Deposit", VE, 107n, 2, duplicateTx, 5n, { provider: WALLET, tokenId: 1n, depositType: 0 });
  const duplicateResult = await accounting({}, {
    logs: [first, first, second],
    receiptLogs: new Map([
      [duplicateTx.toLowerCase(), [first, second, transfer(WALLET, VE, 5n, 107n, 3, duplicateTx)]]
    ])
  });
  assert.equal(duplicateResult.events.length, 2, "Same transaction/logIndex is deduplicated; a distinct logIndex remains evidence.");
  assert.equal(duplicateResult.events.filter((event) => event.status === "RECEIPT_VERIFIED").length, 1);
  assert.deepEqual(duplicateResult.totals.map((total) => total.amountRaw), ["5"]);
}

async function testForeignProviderAndPreAbortedSignal() {
  const foreignTx = tx("9");
  const foreignDeposit = log("Deposit", VE, 108n, 0, foreignTx, 8n, { provider: FOREIGN, tokenId: 1n, depositType: 0 });
  const result = await accounting({}, {
    logs: [foreignDeposit],
    receiptLogs: new Map([
      [foreignTx.toLowerCase(), [foreignDeposit, transfer(FOREIGN, VE, 8n, 108n, 1, foreignTx)]]
    ])
  });
  assert.equal(result.events.length, 0, "A provider-filter bypass from RPC must not become wallet evidence.");
  assert.equal(result.totals.length, 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getWalletAccounting({ fromBlock: "100", toBlock: "110" }, { ...runtime(), signal: controller.signal }));
}

async function testContinuationRetryMetadataAndForeignScope() {
  const depositTx = tx("6");
  const deposit = log("Deposit", VE, 104n, 0, depositTx, 1n, { provider: WALLET, tokenId: 1n, depositType: 0 });
  const fixture: FixtureOptions = {
    logs: [deposit],
    receiptLogs: new Map([
      [depositTx.toLowerCase(), [deposit, transfer(WALLET, VE, 1n, 104n, 1, depositTx)]]
    ])
  };
  const first = await accounting({ blockSpan: 3 }, fixture);
  assert.equal(first.page.scannedToBlock, "102");
  assert.equal(first.page.nextFromBlock, "103");
  const second = await accounting({ fromBlock: "103", blockSpan: 10 }, fixture);
  assert.equal(second.page.nextFromBlock, null);
  assert.equal(second.events.length, 1);
  const failed = await accounting({}, { ...fixture, failLogs: new Set([`${VE.toLowerCase()}:Deposit`]) });
  assert.equal(failed.page.status, "PARTIAL");
  assert.equal(failed.page.retryFromBlock, "100");
  const unknownMeta = await accounting({}, { ...fixture, metadataUnknown: true });
  assert.equal(unknownMeta.totals[0].amountFormatted, null);
  assert.equal(unknownMeta.totals[0].decimals, null);
  const foreignRuntime = runtime();
  foreignRuntime.cfg = config(WALLET);
  const foreign = await getWalletAccounting({ wallet: FOREIGN, fromBlock: "100", toBlock: "110" }, foreignRuntime);
  assert.deepEqual(foreign.scope.tokenIds, []);
  assert.equal(foreign.scope.distributor, null);
}

async function testEndBlockReorgIsRejected() {
  await assert.rejects(accounting({}, { reorgAtEnd: true }), /End block changed during reads/);
}

async function testInMemoryMcpContractAndErrors() {
  const accepted = await accounting({});
  let calls = 0;
  const server = createAeroMcpServer({ walletAccounting: async () => { calls += 1; return accepted; } } as any);
  const client = new Client({ name: "accounting-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.find((tool) => tool.name === "aerodrome_wallet_accounting")?.outputSchema);
    const value = await client.callTool({ name: "aerodrome_wallet_accounting", arguments: { fromBlock: "100", toBlock: "110" } });
    assert.equal(value.isError, undefined);
    accountingSchema.parse(value.structuredContent);
    const malformed = await client.callTool({ name: "aerodrome_wallet_accounting", arguments: { fromBlock: "-1" } });
    assert.equal(malformed.isError, true);
    assert.equal(calls, 1, "Invalid input must not reach the accounting service.");
  } finally {
    await client.close();
    await server.close();
  }

  const failingServer = createAeroMcpServer({ walletAccounting: async () => { throw new Error("receipt RPC token=secret-private-detail"); } } as any);
  const failingClient = new Client({ name: "accounting-error-test", version: "0.1.0" });
  const [failingClientTransport, failingServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([failingServer.connect(failingServerTransport), failingClient.connect(failingClientTransport)]);
  try {
    const failed = await failingClient.callTool({ name: "aerodrome_wallet_accounting", arguments: { fromBlock: "100" } });
    assert.equal(failed.isError, true);
    const text = failed.content[0]?.type === "text" ? failed.content[0].text : "";
    assert.match(text, /^Aerodrome READ_FAILED:/);
    assert.equal(text.includes("secret-private-detail"), false);
  } finally {
    await failingClient.close();
    await failingServer.close();
  }
}

export async function testWalletAccounting() {
  await testReceiptTotalsAndCurrentHoldings();
  await testSpoofedReceiptIsExcluded();
  await testLockedRebaseIsSeparateFromLiquidHoldings();
  await testClaimedRequiresContinuousWalletOwnership();
  await testLiquidRebaseAndLogIdentityGuards();
  await testForeignProviderAndPreAbortedSignal();
  await testContinuationRetryMetadataAndForeignScope();
  await testEndBlockReorgIsRejected();
  await testInMemoryMcpContractAndErrors();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testWalletAccounting().then(() => console.log("Accounting tests passed."));
}
