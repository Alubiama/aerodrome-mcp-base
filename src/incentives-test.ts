import assert from "node:assert/strict";
import { publicConfig } from "./config.js";
import { getVotingIncentives, votingIncentivesInputSchema, votingIncentivesSchema } from "./mcp/incentives.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const POOL = address(10), DEAD_POOL = address(11), GAUGE = address(20), DEAD_GAUGE = address(21), BRIBE = address(30), TOKEN = address(40);

function fixture(mode = "normal") {
  const cfg = publicConfig();
  let blocks = 0;
  const controller = new AbortController();
  const client = {
    getChainId: async () => mode === "wrongChain" ? 1 : 8453,
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
      blocks++;
      if (!blockTag && blockNumber !== 123n) throw new Error("all reads must be pinned");
      return { number: 123n, timestamp: 1500n, hash: `0x${(mode === "reorg" && blocks > 1 ? "cd" : "ab").repeat(32)}` };
    },
    readContract: async (call: { address: string; functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      if (call.blockNumber !== 123n) throw new Error("unpinned contract read");
      if (mode === "abort") controller.abort();
      switch (call.functionName) {
        case "voter": return cfg.contracts.voter;
        case "defaultFactory": return cfg.contracts.defaultFactory;
        case "ve": return address(3);
        case "maxVotingNum": return 4n;
        case "escrowType": return mode === "managed" ? 2 : 0;
        case "balanceOfNFT":
          if (mode === "huge") return 900719925474099312345n;
          if (mode === "powerFail") throw new Error("power unavailable");
          return 40n;
        case "length": return 2n;
        case "totalWeight": return 1000n;
        case "epochStart": return 1000n;
        case "epochNext": return 2000n;
        case "epochVoteStart": return 1100n;
        case "epochVoteEnd": return 1900n;
        case "gauges": return call.args?.[0] === DEAD_POOL ? DEAD_GAUGE : GAUGE;
        case "isGauge": return true;
        case "isAlive": return call.args?.[0] !== DEAD_GAUGE;
        case "weights": return 100n;
        case "gaugeToBribe": return BRIBE;
        case "gaugeToFees": return address(0);
        case "totalSupply": return mode === "zeroSupply" ? 0n : 100n;
        case "balanceOf": return mode === "existingExceeds" ? 101n : 20n;
        case "rewardsListLength": return mode === "missing" || mode === "truncated" ? 2n : 1n;
        case "rewards":
          if (mode === "missing" && call.args?.[0] === 1n) throw new Error("missing reward");
          return TOKEN;
        case "tokenRewardsPerEpoch":
          assert.equal(call.args?.[1], 1000n);
          return mode === "huge" ? 900719925474099300000n : 50n;
        case "symbol": return "SYN";
        case "decimals":
          if (mode === "unknownDecimals") throw new Error("missing decimals");
          return 0;
        default: throw new Error(`unexpected ${call.functionName}`);
      }
    }
  };
  return { controller, runtime: { cfg, client, signal: controller.signal } };
}

export async function testVotingIncentives() {
  const normal = await getVotingIncentives({ pools: [POOL], additionalVoteRaw: "10" }, fixture().runtime);
  votingIncentivesSchema.parse(normal);
  const token = normal.pools[0].status === "VERIFIED_POINT_IN_TIME" ? normal.pools[0].rewardContracts[0].rewardTokens[0] : null;
  assert.equal(token?.estimatedRewardRaw, "4", "50 * 10 / (100 + 10)");
  assert.equal(token?.estimatedRewardFormatted, "4");
  assert.equal(normal.coverage.source, "https://raw.githubusercontent.com/aerodrome-finance/contracts/main/contracts/rewards/Reward.sol");

  const evidence = await getVotingIncentives({ pools: [POOL] }, fixture().runtime);
  assert.equal(evidence.scenario, "EVIDENCE_ONLY");
  assert.equal(evidence.pools[0].rewardContracts[0].rewardTokens[0].estimatedRewardRaw, null);
  const huge = await getVotingIncentives({ pools: [POOL], tokenIds: ["1"] }, fixture("huge").runtime);
  assert.equal(huge.pools[0].rewardContracts[0].rewardTokens[0].estimatedRewardRaw, (900719925474099300000n * 900719925474099312345n / (80n + 900719925474099312345n)).toString());
  const zero = await getVotingIncentives({ pools: [POOL], additionalVoteRaw: "10" }, fixture("zeroSupply").runtime);
  assert.equal(zero.pools[0].status === "VERIFIED_POINT_IN_TIME" ? zero.pools[0].rewardContracts[0].rewardTokens[0].estimatedRewardRaw : null, "50");
  const dead = await getVotingIncentives({ pools: [DEAD_POOL], additionalVoteRaw: "10" }, fixture().runtime);
  assert.equal(dead.pools[0].status === "VERIFIED_POINT_IN_TIME" ? dead.pools[0].rewardContracts[0].rewardTokens[0].estimatedRewardRaw : "bad", null);

  const missing = await getVotingIncentives({ pools: [POOL], additionalVoteRaw: "10", maxRewardTokens: 2 }, fixture("missing").runtime);
  assert.equal(missing.status, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(missing.pools[0].status === "VERIFIED_POINT_IN_TIME" ? missing.pools[0].rewardContracts[0].rewardTokens[1].status : "bad", "READ_FAILED");
  const truncated = await getVotingIncentives({ pools: [POOL], additionalVoteRaw: "10", maxRewardTokens: 1 }, fixture("truncated").runtime);
  assert.equal(truncated.pools[0].status === "VERIFIED_POINT_IN_TIME" ? truncated.pools[0].rewardContracts[0].truncated : false, true);
  const unknown = await getVotingIncentives({ pools: [POOL], additionalVoteRaw: "10" }, fixture("unknownDecimals").runtime);
  assert.equal(unknown.pools[0].status === "VERIFIED_POINT_IN_TIME" ? unknown.pools[0].rewardContracts[0].rewardTokens[0].depositedFormatted : "bad", null);

  const full = await getVotingIncentives({ pools: [POOL], tokenIds: ["1"] }, fixture().runtime);
  assert.equal(full.scenario, "FULL_ALLOCATION_TOKEN_IDS");
  assert.equal(full.candidateVoteRaw, "40");
  assert.equal(full.pools[0].rewardContracts[0].removedExistingVoteRaw, "20");
  assert.equal(full.pools[0].rewardContracts[0].scenarioDenominatorRaw, "120");
  assert.equal(full.pools[0].status === "VERIFIED_POINT_IN_TIME" ? full.pools[0].rewardContracts[0].rewardTokens[0].estimatedRewardRaw : null, "16", "50 * 40 / (100 - 20 + 40)");
  const managed = await getVotingIncentives({ pools: [POOL], tokenIds: ["1"] }, fixture("managed").runtime);
  assert.equal(managed.candidateVoteRaw, null);
  assert.equal(managed.status, "PARTIAL_BOUNDED_SCOPE");
  const powerFail = await getVotingIncentives({ pools: [POOL], tokenIds: ["1"] }, fixture("powerFail").runtime);
  assert.equal(powerFail.candidateVoteRaw, null);
  const exceeds = await getVotingIncentives({ pools: [POOL], tokenIds: ["1"] }, fixture("existingExceeds").runtime);
  assert.equal(exceeds.pools[0].status === "VERIFIED_POINT_IN_TIME" ? exceeds.pools[0].rewardContracts[0].rewardTokens[0].estimatedRewardRaw : "bad", null);

  for (const mode of ["wrongChain", "reorg", "abort"]) await assert.rejects(getVotingIncentives({ pools: [POOL], additionalVoteRaw: "10" }, fixture(mode).runtime), () => true, mode);
  assert.equal(votingIncentivesInputSchema.safeParse({ pools: [], additionalVoteRaw: "1" }).success, false);
  assert.equal(votingIncentivesInputSchema.safeParse({ pools: [POOL, POOL], additionalVoteRaw: "1" }).success, false);
  assert.equal(votingIncentivesInputSchema.safeParse({ pools: [POOL], additionalVoteRaw: "0" }).success, false);
  assert.equal(votingIncentivesInputSchema.safeParse({ pools: [POOL], additionalVoteRaw: "1", maxRewardTokens: 17 }).success, false);
  assert.equal(votingIncentivesInputSchema.safeParse({ pools: [POOL], additionalVoteRaw: "1", tokenIds: ["1"] }).success, false);
  assert.equal(votingIncentivesInputSchema.safeParse({ pools: [POOL] }).success, true);
}

testVotingIncentives().then(() => console.log("Voting incentives tests passed.")).catch(error => { console.error(error); process.exit(1); });
