// Synthetic protocol fixture for offline demo and bounded integration tests.
import { publicConfig } from "./config.js";
export const fixtureAddress = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
export function overviewFixture(mode = "normal") {
  const wallet = fixtureAddress(2), ve = fixtureAddress(1), token = fixtureAddress(3), gauge = fixtureAddress(4);
  const cfg = publicConfig();
  const calls: string[] = [];
  let blockReads = 0;
  const controller = new AbortController();
  const client = {
    getChainId: async () => mode === "wrongChain" ? 1 : 8453,
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => {
      blockReads++;
      if (!args.blockTag && args.blockNumber !== 123n) throw new Error("Unpinned recheck");
      return { number: 123n, timestamp: 1800n, hash: `0x${(mode === "reorg" && blockReads > 1 ? "cd" : "ab").repeat(32)}` };
    },
    getBalance: async (args: { address: string; blockNumber?: bigint }) => {
      if (args.blockNumber !== 123n) throw new Error("Unpinned balance");
      if (mode === "nativeFail") throw new Error("synthetic unavailable");
      return 1250000000000000000n;
    },
    readContract: async (call: { address: string; functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      calls.push(call.functionName);
      if (call.blockNumber !== 123n) throw new Error("Unpinned contract read");
      if (mode === "cancel") controller.abort();
      switch (call.functionName) {
        case "voter": return cfg.contracts.voter;
        case "defaultFactory": return cfg.contracts.defaultFactory;
        case "ve": return ve;
        case "token": return token;
        case "length": return 2n;
        case "totalWeight": return 100000000000000000000n;
        case "maxVotingNum": return 4n;
        case "epochStart": return 1000n;
        case "epochNext": return 2000n;
        case "epochVoteStart": return 1100n;
        case "epochVoteEnd": return 1900n;
        case "balanceOf":
          if (call.address === ve) {
            if (mode === "discoveryFail") throw new Error("synthetic unavailable");
            return mode === "empty" ? 0n : mode === "many" ? 17n : 1n;
          }
          return call.address.toLowerCase() === cfg.tokens.USDC.toLowerCase() ? 12500000n : 3000000000000000000n;
        case "ownerToNFTokenIdList": return mode === "duplicate" ? 0n : BigInt(String(call.args?.[1])) + 1n;
        case "ownerOf": return mode === "ownerMismatch" ? fixtureAddress(9) : wallet;
        case "escrowType": return mode === "managed" ? 2 : 0;
        case "locked": return { amount: 40000000000000000000n, end: 2000n, isPermanent: false };
        case "symbol": return call.address.toLowerCase() === cfg.tokens.USDC.toLowerCase() ? "USDC" : "DEMO";
        case "decimals":
          if (mode === "metadataFail" && call.address === token) throw new Error("synthetic unavailable");
          return call.address.toLowerCase() === cfg.tokens.USDC.toLowerCase() ? 6 : 18;
        case "balanceOfNFT":
          if (mode === "votingFail") throw new Error("synthetic unavailable");
          return 20000000000000000000n;
        case "lastVoted": return 0n;
        case "usedWeights": return 0n;
        case "isGauge": return true;
        case "rewardToken":
          if (mode === "rewardsFail") throw new Error("synthetic unavailable");
          return token;
        case "earned": return 2500000000000000000n;
        default: throw new Error(`Unexpected fixture call ${call.functionName}`);
      }
    }
  };
  return { wallet, token, gauge, calls, runtime: { cfg, client, signal: controller.signal } };
}
