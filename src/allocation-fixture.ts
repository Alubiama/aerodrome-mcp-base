import assert from "node:assert/strict";
import { publicConfig } from "./config.js";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const POOL = address(10), DEAD_POOL = address(11), GAUGE = address(20), DEAD_GAUGE = address(21), BRIBE = address(30), TOKEN = address(40);

export function fixture(mode = "normal") {
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
        case "gauges": return call.args?.[0] === DEAD_POOL ? DEAD_GAUGE : String(call.args?.[0]).toLowerCase() === address(12) ? address(22) : GAUGE;
        case "isGauge": return true;
        case "isAlive": return call.args?.[0] !== DEAD_GAUGE;
        case "weights": return 100n;
        case "gaugeToBribe": return String(call.args?.[0]).toLowerCase() === address(22) ? address(32) : BRIBE;
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


