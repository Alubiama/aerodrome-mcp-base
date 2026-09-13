import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)"
]);

export const voterAbi = parseAbi([
  "function ve() view returns (address)",
  "function maxVotingNum() view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function length() view returns (uint256)",
  "function pools(uint256 index) view returns (address)",
  "function poolVote(uint256 tokenId, uint256 index) view returns (address)",
  "function votes(uint256 tokenId, address pool) view returns (uint256)",
  "function weights(address pool) view returns (uint256)",
  "function usedWeights(uint256 tokenId) view returns (uint256)",
  "function lastVoted(uint256 tokenId) view returns (uint256)",
  "function gauges(address pool) view returns (address)",
  "function gaugeToFees(address gauge) view returns (address)",
  "function gaugeToBribe(address gauge) view returns (address)",
  "function isGauge(address gauge) view returns (bool)",
  "function isAlive(address gauge) view returns (bool)",
  "function epochStart(uint256 timestamp) pure returns (uint256)",
  "function epochNext(uint256 timestamp) pure returns (uint256)",
  "function epochVoteStart(uint256 timestamp) pure returns (uint256)",
  "function epochVoteEnd(uint256 timestamp) pure returns (uint256)"
]);

export const gaugeAbi = parseAbi([
  "function rewardToken() view returns (address)",
  "function earned(address account) view returns (uint256)"
]);

export const votingRewardAbi = parseAbi([
  "function rewardsListLength() view returns (uint256)",
  "function rewards(uint256 index) view returns (address)",
  "function earned(address token, uint256 tokenId) view returns (uint256)",
  "function isReward(address token) view returns (bool)"
]);

export const veAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)",
  "function token() view returns (address)",
  "function locked(uint256 tokenId) view returns ((int128 amount, uint256 end, bool isPermanent))",
  "function escrowType(uint256 tokenId) view returns (uint8)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedOrOwner(address spender, uint256 tokenId) view returns (bool)",
  "function balanceOfNFT(uint256 tokenId) view returns (uint256)"
]);

export const routerAbi = parseAbi(["function voter() view returns (address)", "function defaultFactory() view returns (address)"]);
