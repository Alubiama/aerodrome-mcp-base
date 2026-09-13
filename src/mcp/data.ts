import { formatUnits, getAddress, type Address } from "viem";
import { gaugeAbi, routerAbi, veAbi, voterAbi, votingRewardAbi } from "../abi.js";
import { makeClient } from "../client.js";
import {
  defaultFactoryAddress,
  loadConfig,
  normalizeAddress,
  routerAddress,
  uniqAddresses,
  veTokenIds,
  voterAddress,
  walletAddress,
  zeroAddress
} from "../config.js";
import { readContractsBounded } from "../discovery.js";
import { getTokenMeta, symbolForAddress } from "../tokens.js";
import type { AppConfig } from "../types.js";

const MAX_TOOL_TOKEN_IDS = 16;
const MAX_REWARD_TOKENS = 64n;
const MAX_INTEROPERABLE_UNIX_SECONDS = 253_402_300_799n;

export type ToolRuntime = {
  cfg: AppConfig;
  client: any;
  signal?: AbortSignal;
  pinnedObservation?: Awaited<ReturnType<typeof observation>>;
};

export type WalletRewardsInput = {
  includeZero?: boolean;
  maxItems?: number;
};

export type VotingPositionInput = {
  tokenIds?: string[];
};

type Observation = {
  observedAt: string;
  blockNumber: string;
  blockHash: string | null;
  blockTimestamp: string;
};

export function unixSecondsToIso(value: bigint, label: string): string {
  if (value < 0n || value > MAX_INTEROPERABLE_UNIX_SECONDS) {
    throw new Error(`${label} is outside the supported Unix timestamp range.`);
  }
  return new Date(Number(value) * 1_000).toISOString();
}

export function createDefaultRuntime(signal?: AbortSignal): ToolRuntime {
  signal?.throwIfAborted();
  const cfg = loadConfig();
  return { cfg, signal, client: makeClient(cfg, { batchRpc: true, timeoutMs: 30_000, signal }) };
}

async function assertBaseChain(client: any): Promise<number> {
  const chainId = await client.getChainId();
  if (chainId !== 8453) throw new Error(`Wrong chainId from RPC: ${chainId}; expected Base mainnet 8453.`);
  return chainId;
}

async function observation(client: any): Promise<{ rawBlockNumber: bigint; rawTimestamp: bigint; value: Observation }> {
  const block = await client.getBlock({ blockTag: "latest" });
  if (typeof block.number !== "bigint" || typeof block.timestamp !== "bigint") {
    throw new Error("Base RPC returned a latest block without number or timestamp.");
  }
  return {
    rawBlockNumber: block.number,
    rawTimestamp: block.timestamp,
    value: {
      observedAt: new Date().toISOString(),
      blockNumber: block.number.toString(),
      blockHash: typeof block.hash === "string" ? block.hash : null,
      blockTimestamp: unixSecondsToIso(block.timestamp, "Base block timestamp")
    }
  };
}

async function epochWindow(client: any, voter: Address, timestamp: bigint, blockNumber: bigint) {
  const calls = ["epochStart", "epochNext", "epochVoteStart", "epochVoteEnd"].map((functionName) => ({
    address: voter,
    abi: voterAbi,
    functionName,
    args: [timestamp],
    blockNumber
  }));
  const results = await readContractsBounded(client, calls, 4);
  const values = results.map((item, index) => {
    if (item?.status !== "success" || typeof item.result !== "bigint") {
      throw new Error(`Could not read Aerodrome epoch boundary ${calls[index].functionName}.`);
    }
    return item.result as bigint;
  });
  const [start, next, voteStart, voteEnd] = values;
  if (!(start <= voteStart && voteStart <= voteEnd && voteEnd <= next)) {
    throw new Error("Aerodrome epoch boundaries are inconsistent.");
  }
  return {
    start: unixSecondsToIso(start, "Aerodrome epoch start"),
    next: unixSecondsToIso(next, "Aerodrome next epoch"),
    normalVoteStart: unixSecondsToIso(voteStart, "Aerodrome vote start"),
    normalVoteEnd: unixSecondsToIso(voteEnd, "Aerodrome vote end"),
    normalVotingOpen: timestamp > voteStart && timestamp <= voteEnd,
    rawStart: start
  };
}

async function readRequired<T>(client: any, call: Record<string, unknown>, label: string): Promise<T> {
  try {
    return await client.readContract(call) as T;
  } catch {
    throw new Error(`${label} read failed.`);
  }
}

async function currentPoolVotesAtBlock(
  client: any,
  voter: Address,
  tokenId: bigint,
  blockNumber: bigint,
  maxVotingNum?: bigint
): Promise<Address[]> {
  const usedWeight = await readRequired<bigint>(client, {
    address: voter,
    abi: voterAbi,
    functionName: "usedWeights",
    args: [tokenId],
    blockNumber
  }, `Voter.usedWeights(${tokenId})`);
  if (usedWeight === 0n) return [];

  const max = maxVotingNum ?? await readRequired<bigint>(client, {
    address: voter,
    abi: voterAbi,
    functionName: "maxVotingNum",
    blockNumber
  }, "Voter.maxVotingNum");
  if (max < 1n || max > 256n) throw new Error(`Unsafe Voter.maxVotingNum value: ${max}.`);

  const pools: Address[] = [];
  for (let start = 0n; start < max; start += 4n) {
    const end = start + 4n > max ? max : start + 4n;
    const calls = [];
    for (let index = start; index < end; index += 1n) {
      calls.push({ address: voter, abi: voterAbi, functionName: "poolVote", args: [tokenId, index], blockNumber });
    }
    const results = await readContractsBounded(client, calls, 4, false);
    let complete = false;
    for (const item of results) {
      if (item?.status !== "success") {
        const detail = item?.error instanceof Error ? item.error.message : String(item?.error ?? "unknown read error");
        if (!/revert|out of bounds|invalid opcode/i.test(detail)) {
          throw new Error(`Current poolVote read failed for veNFT #${tokenId}.`);
        }
        complete = true;
        break;
      }
      if (typeof item.result !== "string" || item.result === zeroAddress()) {
        complete = true;
        break;
      }
      pools.push(item.result as Address);
    }
    if (complete) break;
  }
  return uniqAddresses(pools);
}

function parseTokenIds(input: string[] | undefined, cfg: AppConfig): bigint[] {
  const raw = input ?? veTokenIds(cfg).map(String);
  if (raw.length < 1 || raw.length > MAX_TOOL_TOKEN_IDS) {
    throw new Error(`tokenIds must contain between 1 and ${MAX_TOOL_TOKEN_IDS} items.`);
  }
  const parsed = raw.map((value) => {
    if (!/^\d{1,78}$/.test(value)) throw new Error(`Invalid veNFT tokenId: ${value}.`);
    const id = BigInt(value);
    if (id <= 0n || id >= 1n << 256n) throw new Error(`veNFT tokenId is outside uint256: ${value}.`);
    return id;
  });
  if (new Set(parsed.map(String)).size !== parsed.length) throw new Error("tokenIds must not contain duplicates.");
  return parsed;
}

export async function getProtocolStatus(runtime: ToolRuntime = createDefaultRuntime()) {
  runtime.signal?.throwIfAborted();
  const { cfg, client } = runtime;
  const chainId = await assertBaseChain(client);
  const obs = runtime.pinnedObservation ?? await observation(client);
  const voter = voterAddress(cfg);
  const router = routerAddress(cfg);
  const factory = defaultFactoryAddress(cfg);

  const calls = [
    { address: router, abi: routerAbi, functionName: "voter", blockNumber: obs.rawBlockNumber },
    { address: router, abi: routerAbi, functionName: "defaultFactory", blockNumber: obs.rawBlockNumber },
    { address: voter, abi: voterAbi, functionName: "ve", blockNumber: obs.rawBlockNumber },
    { address: voter, abi: voterAbi, functionName: "maxVotingNum", blockNumber: obs.rawBlockNumber },
    { address: voter, abi: voterAbi, functionName: "length", blockNumber: obs.rawBlockNumber },
    { address: voter, abi: voterAbi, functionName: "totalWeight", blockNumber: obs.rawBlockNumber }
  ];
  const results = await readContractsBounded(client, calls, 4);
  if (results.some((item) => item?.status !== "success")) throw new Error("One or more Aerodrome protocol identity reads failed.");
  const [routerVoter, routerFactory, ve, maxVotingNum, poolCount, totalWeight] = results.map((item) => item.result);
  if (getAddress(routerVoter as Address) !== voter) throw new Error("Configured Router.voter does not match the official Voter.");
  if (getAddress(routerFactory as Address) !== factory) throw new Error("Configured Router.defaultFactory does not match the official factory.");

  const epoch = await epochWindow(client, voter, obs.rawTimestamp, obs.rawBlockNumber);
  return {
    status: "VERIFIED_POINT_IN_TIME",
    readOnly: true,
    chainId,
    chain: "Base mainnet",
    observation: obs.value,
    contracts: { voter, router, defaultFactory: factory, votingEscrow: getAddress(ve as Address) },
    protocol: {
      poolCount: String(poolCount),
      totalVoteWeightRaw: String(totalWeight),
      maxPoolsPerVote: String(maxVotingNum)
    },
    epoch: {
      start: epoch.start,
      next: epoch.next,
      normalVoteStart: epoch.normalVoteStart,
      normalVoteEnd: epoch.normalVoteEnd,
      normalVotingOpen: epoch.normalVotingOpen
    },
    coverage: {
      scope: "official configured contracts at one Base block",
      pricing: "not included",
      transactions: "not generated or simulated"
    },
    warnings: [] as string[]
  };
}

export async function getVotingPosition(
  input: VotingPositionInput = {},
  runtime: ToolRuntime = createDefaultRuntime()
) {
  runtime.signal?.throwIfAborted();
  const { cfg, client } = runtime;
  const voter = voterAddress(cfg);
  const tokenIds = parseTokenIds(input.tokenIds, cfg);
  const chainId = await assertBaseChain(client);
  const obs = runtime.pinnedObservation ?? await observation(client);
  const [ve, totalWeight, maxVotingNum] = await Promise.all([
    readRequired<Address>(client, { address: voter, abi: voterAbi, functionName: "ve", blockNumber: obs.rawBlockNumber }, "Voter.ve"),
    readRequired<bigint>(client, { address: voter, abi: voterAbi, functionName: "totalWeight", blockNumber: obs.rawBlockNumber }, "Voter.totalWeight"),
    readRequired<bigint>(client, { address: voter, abi: voterAbi, functionName: "maxVotingNum", blockNumber: obs.rawBlockNumber }, "Voter.maxVotingNum")
  ]);
  const epoch = await epochWindow(client, voter, obs.rawTimestamp, obs.rawBlockNumber);
  const positions = [];
  const warnings: string[] = [];

  for (const tokenId of tokenIds) {
    runtime.signal?.throwIfAborted();
    const [usedWeight, lastVoted, owner, currentVotingPower] = await Promise.all([
      readRequired<bigint>(client, { address: voter, abi: voterAbi, functionName: "usedWeights", args: [tokenId], blockNumber: obs.rawBlockNumber }, `usedWeights(${tokenId})`),
      readRequired<bigint>(client, { address: voter, abi: voterAbi, functionName: "lastVoted", args: [tokenId], blockNumber: obs.rawBlockNumber }, `lastVoted(${tokenId})`),
      readRequired<Address>(client, { address: ve, abi: veAbi, functionName: "ownerOf", args: [tokenId], blockNumber: obs.rawBlockNumber }, `ownerOf(${tokenId})`),
      readRequired<bigint>(client, { address: ve, abi: veAbi, functionName: "balanceOfNFT", args: [tokenId], blockNumber: obs.rawBlockNumber }, `balanceOfNFT(${tokenId})`)
    ]);
    const pools = await currentPoolVotesAtBlock(client, voter, tokenId, obs.rawBlockNumber, maxVotingNum);
    const calls = pools.flatMap((pool) => [
      { address: voter, abi: voterAbi, functionName: "votes", args: [tokenId, pool], blockNumber: obs.rawBlockNumber },
      { address: voter, abi: voterAbi, functionName: "weights", args: [pool], blockNumber: obs.rawBlockNumber },
      { address: voter, abi: voterAbi, functionName: "gauges", args: [pool], blockNumber: obs.rawBlockNumber }
    ]);
    const results = await readContractsBounded(client, calls, 4);
    const poolRows = [];
    for (let index = 0; index < pools.length; index += 1) {
      runtime.signal?.throwIfAborted();
      const vote = results[index * 3];
      const poolWeight = results[index * 3 + 1];
      const gauge = results[index * 3 + 2];
      if (vote?.status !== "success" || typeof vote.result !== "bigint" ||
          poolWeight?.status !== "success" || typeof poolWeight.result !== "bigint" ||
          gauge?.status !== "success" || typeof gauge.result !== "string") {
        warnings.push(`Incomplete current-vote reads for veNFT #${tokenId} pool ${pools[index]}.`);
        continue;
      }
      const live = gauge.result === zeroAddress() ? false : await readRequired<boolean>(client, {
        address: voter,
        abi: voterAbi,
        functionName: "isAlive",
        args: [gauge.result],
        blockNumber: obs.rawBlockNumber
      }, `isAlive(${gauge.result})`);
      poolRows.push({
        pool: pools[index],
        gauge: gauge.result,
        gaugeAlive: live,
        voteWeightRaw: vote.result.toString(),
        poolWeightRaw: poolWeight.result.toString(),
        shareOfPoolBps: poolWeight.result === 0n ? null : ((vote.result * 10_000n) / poolWeight.result).toString()
      });
    }
    if (usedWeight > 0n && pools.length === 0) warnings.push(`veNFT #${tokenId} has used weight but no current poolVote entries were readable.`);
    positions.push({
      tokenId: tokenId.toString(),
      owner: getAddress(owner),
      currentVotingPowerRaw: currentVotingPower.toString(),
      usedWeightRaw: usedWeight.toString(),
      shareOfProtocolWeightBps: totalWeight === 0n ? null : ((usedWeight * 10_000n) / totalWeight).toString(),
      lastVotedAt: lastVoted === 0n ? null : unixSecondsToIso(lastVoted, `lastVoted(${tokenId})`),
      votedThisEpoch: lastVoted !== 0n && lastVoted >= epoch.rawStart,
      pools: poolRows
    });
  }

  return {
    status: warnings.length === 0 ? "VERIFIED_POINT_IN_TIME" : "PARTIAL_POINT_IN_TIME",
    readOnly: true,
    chainId,
    observation: obs.value,
    epoch: {
      start: epoch.start,
      next: epoch.next,
      normalVoteStart: epoch.normalVoteStart,
      normalVoteEnd: epoch.normalVoteEnd,
      normalVotingOpen: epoch.normalVotingOpen
    },
    totalProtocolWeightRaw: totalWeight.toString(),
    positions,
    coverage: {
      scope: "current on-chain poolVote entries only",
      historicalVotes: "not scanned",
      profitability: "not calculated"
    },
    warnings
  };
}

async function rewardTokensAtBlock(client: any, rewardContract: Address, blockNumber: bigint): Promise<Address[]> {
  const length = await readRequired<bigint>(client, {
    address: rewardContract,
    abi: votingRewardAbi,
    functionName: "rewardsListLength",
    blockNumber
  }, `rewardsListLength(${rewardContract})`);
  if (length < 0n || length > MAX_REWARD_TOKENS) {
    throw new Error(`Reward token list for ${rewardContract} exceeds the hard limit ${MAX_REWARD_TOKENS}.`);
  }
  const calls = [];
  for (let index = 0n; index < length; index += 1n) {
    calls.push({ address: rewardContract, abi: votingRewardAbi, functionName: "rewards", args: [index], blockNumber });
  }
  const results = await readContractsBounded(client, calls, 4);
  const tokens = results.flatMap((item) => item?.status === "success" && typeof item.result === "string" ? [item.result as Address] : []);
  if (tokens.length !== Number(length)) throw new Error(`Could not verify the complete reward-token list for ${rewardContract}.`);
  return uniqAddresses(tokens);
}

export async function getWalletRewards(
  input: WalletRewardsInput = {},
  runtime: ToolRuntime = createDefaultRuntime()
) {
  runtime.signal?.throwIfAborted();
  const { cfg, client } = runtime;
  const includeZero = input.includeZero === true;
  const maxItems = input.maxItems ?? 100;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 200) throw new Error("maxItems must be between 1 and 200.");
  const tokenIds = parseTokenIds(undefined, cfg);
  const chainId = await assertBaseChain(client);
  const obs = runtime.pinnedObservation ?? await observation(client);
  const voter = voterAddress(cfg);
  const wallet = walletAddress(cfg);
  const warnings = [
    "Zero rows mean no reward was observed in this bounded scope; they do not prove that no older unclaimed reward exists."
  ];
  let incomplete = false;
  const [maxVotingNum, ve] = await Promise.all([
    readRequired<bigint>(client, {
      address: voter,
      abi: voterAbi,
      functionName: "maxVotingNum",
      blockNumber: obs.rawBlockNumber
    }, "Voter.maxVotingNum"),
    readRequired<Address>(client, {
      address: voter,
      abi: voterAbi,
      functionName: "ve",
      blockNumber: obs.rawBlockNumber
    }, "Voter.ve")
  ]);
  for (const tokenId of tokenIds) {
    runtime.signal?.throwIfAborted();
    const owner = await readRequired<Address>(client, {
      address: ve,
      abi: veAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: obs.rawBlockNumber
    }, `ownerOf(${tokenId})`);
    if (getAddress(owner) !== wallet) {
      throw new Error(`Configured veNFT #${tokenId} is not owned by the configured wallet.`);
    }
  }

  const tokenPools: Array<{ tokenId: bigint; pool: Address }> = [];
  for (const tokenId of tokenIds) {
    runtime.signal?.throwIfAborted();
    const pools = await currentPoolVotesAtBlock(client, voter, tokenId, obs.rawBlockNumber, maxVotingNum);
    tokenPools.push(...pools.map((pool) => ({ tokenId, pool })));
  }
  const pools = uniqAddresses(tokenPools.map((item) => item.pool));
  const gaugeResults = await readContractsBounded(client, pools.map((pool) => ({
    address: voter,
    abi: voterAbi,
    functionName: "gauges",
    args: [pool],
    blockNumber: obs.rawBlockNumber
  })), 4);
  const gaugeByPool = new Map<string, Address>();
  gaugeResults.forEach((item, index) => {
    if (item?.status === "success" && typeof item.result === "string" && item.result !== zeroAddress()) {
      gaugeByPool.set(pools[index].toLowerCase(), item.result as Address);
    } else if (item?.status !== "success" || typeof item.result !== "string") {
      incomplete = true;
      warnings.push(`Could not verify the gauge mapping for pool ${pools[index]}; rewards for that pool were skipped.`);
    }
  });

  const rewardContracts: Array<{ pool: Address; gauge: Address; type: "bribe" | "fee"; address: Address }> = [];
  for (const pool of pools) {
    runtime.signal?.throwIfAborted();
    const gauge = gaugeByPool.get(pool.toLowerCase());
    if (!gauge) continue;
    for (const [type, functionName] of [["bribe", "gaugeToBribe"], ["fee", "gaugeToFees"]] as const) {
      const address = await readRequired<Address>(client, {
        address: voter,
        abi: voterAbi,
        functionName,
        args: [gauge],
        blockNumber: obs.rawBlockNumber
      }, `${functionName}(${gauge})`);
      if (address !== zeroAddress()) rewardContracts.push({ pool, gauge, type, address });
    }
  }

  const votingRows = [];
  let examinedItems = 0;
  for (const tokenPool of tokenPools) {
    runtime.signal?.throwIfAborted();
    const gauge = gaugeByPool.get(tokenPool.pool.toLowerCase());
    if (!gauge) continue;
    const matching = rewardContracts.filter((item) => item.pool.toLowerCase() === tokenPool.pool.toLowerCase());
    for (const reward of matching) {
      let tokens: Address[];
      try {
        tokens = await rewardTokensAtBlock(client, reward.address, obs.rawBlockNumber);
      } catch (error) {
        runtime.signal?.throwIfAborted();
        incomplete = true;
        warnings.push(`Skipped ${reward.type} reward contract ${reward.address}: ${(error as Error).message}`);
        continue;
      }
      for (const token of tokens) {
        runtime.signal?.throwIfAborted();
        examinedItems += 1;
        if (examinedItems > maxItems) throw new Error(`Reward scan exceeds maxItems=${maxItems}; narrow the configured veNFT scope.`);
        let amount: bigint;
        try {
          amount = await readRequired<bigint>(client, {
            address: reward.address,
            abi: votingRewardAbi,
            functionName: "earned",
            args: [token, tokenPool.tokenId],
            blockNumber: obs.rawBlockNumber
          }, `earned(${token}, ${tokenPool.tokenId})`);
        } catch (error) {
          runtime.signal?.throwIfAborted();
          incomplete = true;
          warnings.push(`Skipped ${reward.type} reward ${reward.address} token ${token} for veNFT #${tokenPool.tokenId}: ${(error as Error).message}`);
          continue;
        }
        if (!includeZero && amount === 0n) continue;
        const meta = await getTokenMeta(client, token, symbolForAddress(token, cfg.tokens), runtime.pinnedObservation?.rawBlockNumber);
        votingRows.push({
          tokenId: tokenPool.tokenId.toString(),
          pool: tokenPool.pool,
          gauge,
          type: reward.type,
          rewardContract: reward.address,
          token: meta.address,
          symbol: meta.symbol,
          decimals: meta.decimals,
          amountRaw: amount.toString(),
          amountFormatted: formatUnits(amount, meta.decimals)
        });
      }
    }
  }

  const configuredGauges = uniqAddresses(
    cfg.gaugeAddresses.map((value, index) => normalizeAddress(value, `gaugeAddresses[${index}]`))
  );
  const gaugeRows = [];
  for (const gauge of configuredGauges) {
    runtime.signal?.throwIfAborted();
    examinedItems += 1;
    if (examinedItems > maxItems) throw new Error(`Reward scan exceeds maxItems=${maxItems}.`);
    let isGauge: boolean;
    let token: Address;
    let amount: bigint;
    try {
      isGauge = await readRequired<boolean>(client, {
        address: voter,
        abi: voterAbi,
        functionName: "isGauge",
        args: [gauge],
        blockNumber: obs.rawBlockNumber
      }, `isGauge(${gauge})`);
      if (!isGauge) continue;
      token = await readRequired<Address>(client, {
        address: gauge,
        abi: gaugeAbi,
        functionName: "rewardToken",
        blockNumber: obs.rawBlockNumber
      }, `rewardToken(${gauge})`);
      amount = await readRequired<bigint>(client, {
        address: gauge,
        abi: gaugeAbi,
        functionName: "earned",
        args: [wallet],
        blockNumber: obs.rawBlockNumber
      }, `gauge earned(${wallet})`);
    } catch (error) {
      runtime.signal?.throwIfAborted();
      incomplete = true;
      warnings.push(`Skipped gauge reward ${gauge}: ${(error as Error).message}`);
      continue;
    }
    if (!includeZero && amount === 0n) continue;
    const meta = await getTokenMeta(client, token, symbolForAddress(token, cfg.tokens), runtime.pinnedObservation?.rawBlockNumber);
    gaugeRows.push({
      gauge,
      token: meta.address,
      symbol: meta.symbol,
      decimals: meta.decimals,
      amountRaw: amount.toString(),
      amountFormatted: formatUnits(amount, meta.decimals)
    });
  }

  return {
    status: incomplete ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE",
    readOnly: true,
    chainId,
    wallet,
    configuredTokenIds: tokenIds.map(String),
    observation: obs.value,
    votingRewards: votingRows,
    gaugeRewards: gaugeRows,
    totals: { examinedItems, votingRewardItems: votingRows.length, gaugeRewardItems: gaugeRows.length },
    coverage: {
      scope: "configured veNFT current votes plus explicitly configured LP gauges",
      historicalUnclaimedPools: "not scanned and may be omitted",
      tokenPrices: "not included",
      displayMetadata: runtime.pinnedObservation ? "untrusted token labels read at the observed block; non-USDC decimals may fall back to 18" : "untrusted token labels; latest or process cache, not the observed block; non-USDC decimals may fall back to 18",
      realizableValue: "not calculated"
    },
    warnings
  };
}

/** Configured wallet scope only; all sections share one block, including metadata. */
export async function getWalletSnapshot(
  input: WalletRewardsInput = {},
  runtime: ToolRuntime = createDefaultRuntime()
) {
  runtime.signal?.throwIfAborted();
  await assertBaseChain(runtime.client);
  const obs = await observation(runtime.client);
  if (!obs.value.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(obs.value.blockHash)) {
    throw new Error("Snapshot requires a valid block hash.");
  }
  const pinned = { ...runtime, pinnedObservation: obs };
  const protocol = await getProtocolStatus(pinned);
  const voting = await getVotingPosition({}, pinned);
  const rewards = await getWalletRewards(input, pinned);
  const finalBlock = await runtime.client.getBlock({ blockNumber: obs.rawBlockNumber });
  runtime.signal?.throwIfAborted();
  if (finalBlock.number !== obs.rawBlockNumber || finalBlock.hash !== obs.value.blockHash) {
    throw new Error("Snapshot block changed during reads; retry.");
  }
  return {
    status: voting.status.startsWith("PARTIAL") || rewards.status.startsWith("PARTIAL")
      ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE",
    readOnly: true,
    chainId: 8453,
    observation: obs.value,
    protocol, voting, rewards,
    coverage: {
      scope: "configured wallet, veNFT current votes and explicitly configured LP gauges at one Base block",
      consistency: "block-number pinned reads with block hash rechecked after completion; RPC trust required",
      historicalRewards: "not scanned; zero current rewards does not prove no historical claimable rewards",
      pricing: "not included"
    },
    warnings: [...new Set([...protocol.warnings, ...voting.warnings, ...rewards.warnings])]
  };
}

export type PoolComparisonInput = { pools: string[] };

/** Public Voter evidence only. Input order is preserved; no profitability ranking. */
export async function getPoolComparison(
  input: PoolComparisonInput,
  runtime: ToolRuntime = createDefaultRuntime()
) {
  if (!Array.isArray(input.pools) || input.pools.length < 2 || input.pools.length > 16) {
    throw new Error("Choose between 2 and 16 distinct pool addresses.");
  }
  const pools = input.pools.map((value, index) => normalizeAddress(value, `pools[${index}]`));
  if (pools.includes(zeroAddress()) || uniqAddresses(pools).length !== pools.length) {
    throw new Error("Pool addresses must be nonzero and distinct.");
  }
  runtime.signal?.throwIfAborted();
  await assertBaseChain(runtime.client);
  const obs = await observation(runtime.client);
  if (!obs.value.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(obs.value.blockHash)) {
    throw new Error("Comparison requires a valid block hash.");
  }
  const protocol = await getProtocolStatus({ ...runtime, pinnedObservation: obs });
  const totalWeight = BigInt(protocol.protocol.totalVoteWeightRaw);
  const voter = voterAddress(runtime.cfg);
  const read = <T>(functionName: string, args: Address[]) => readRequired<T>(runtime.client, {
    address: voter, abi: voterAbi, functionName, args, blockNumber: obs.rawBlockNumber
  }, "Pool comparison");
  const rows = [];
  const warnings: string[] = [];
  for (const pool of pools) {
    runtime.signal?.throwIfAborted();
    try {
      const gauge = getAddress(await read<Address>("gauges", [pool]));
      if (gauge === zeroAddress()) {
        rows.push({ pool, status: "NOT_REGISTERED", gauge: null, gaugeAlive: null,
          voteWeightRaw: null, shareOfProtocolWeightBps: null, bribeContract: null, feeContract: null });
        warnings.push(`Pool ${pool} has no gauge in the configured Voter; it is not comparable in this voting scope.`);
        continue;
      }
      const registered = await read<boolean>("isGauge", [gauge]);
      if (registered !== true) throw new Error("Gauge registration could not be verified.");
      const weight = await read<bigint>("weights", [pool]);
      const gaugeAlive = await read<boolean>("isAlive", [gauge]);
      if (typeof weight !== "bigint" || weight < 0n || weight > totalWeight || typeof gaugeAlive !== "boolean") {
        throw new Error("Invalid pool evidence.");
      }
      const bribe = getAddress(await read<Address>("gaugeToBribe", [gauge]));
      const fee = getAddress(await read<Address>("gaugeToFees", [gauge]));
      rows.push({ pool, status: "VERIFIED_POINT_IN_TIME", gauge, gaugeAlive,
        voteWeightRaw: weight.toString(),
        shareOfProtocolWeightBps: totalWeight === 0n ? null : (weight * 10_000n / totalWeight).toString(),
        bribeContract: bribe === zeroAddress() ? null : bribe,
        feeContract: fee === zeroAddress() ? null : fee });
    } catch {
      runtime.signal?.throwIfAborted();
      rows.push({ pool, status: "READ_FAILED", gauge: null, gaugeAlive: null,
        voteWeightRaw: null, shareOfProtocolWeightBps: null, bribeContract: null, feeContract: null });
      warnings.push(`Pool ${pool}: voting evidence could not be verified; missing values are unknown, not zero.`);
    }
  }
  const finalBlock = await runtime.client.getBlock({ blockNumber: obs.rawBlockNumber });
  runtime.signal?.throwIfAborted();
  if (finalBlock.number !== obs.rawBlockNumber || finalBlock.hash !== obs.value.blockHash) {
    throw new Error("Comparison block changed during reads; retry.");
  }
  return {
    status: rows.every(row => row.status === "VERIFIED_POINT_IN_TIME") ? "VERIFIED_BOUNDED_SCOPE" : "PARTIAL_BOUNDED_SCOPE",
    readOnly: true, chainId: 8453, observation: obs.value,
    voter, epoch: protocol.epoch, totalProtocolWeightRaw: totalWeight.toString(), pools: rows,
    coverage: {
      scope: "selected pool addresses in the configured official Voter; input order preserved",
      consistency: "block-number pinned reads with block hash rechecked after completion; RPC trust required",
      weights: "current voting weights; shares are integer basis points rounded down, not yield or returns",
      rewards: "reward contract addresses only; amounts and historical rewards not scanned",
      valuation: "prices, liquidity, volume, APR and profitability not calculated"
    }, warnings
  };
}
