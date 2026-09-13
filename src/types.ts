import type { Address } from "viem";
export type AppConfig = {
 walletAddress: string; baseRpcUrl: string;
 contracts: { voter: string; router: string; defaultFactory: string };
 tokens: Record<string, string>; veNftTokenIds: string[]; gaugeAddresses: string[];
};
export type TokenMeta = { address: Address; symbol: string; decimals: number };
