import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address } from "viem";
import * as z from "zod/v4";
import type { AppConfig } from "./types.js";
const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const configSchema = z.strictObject({
 walletAddress: z.string().refine(value => isAddress(value) && value.toLowerCase() !== ZERO).optional(),
 veNftTokenIds: z.array(z.string().regex(/^\d{1,78}$/).refine(value => BigInt(value) > 0n && BigInt(value) < (1n << 256n))).max(16)
   .refine(values => new Set(values.map(value => BigInt(value).toString())).size === values.length).default([]),
 gaugeAddresses: z.array(z.string().refine(value => isAddress(value) && value.toLowerCase() !== ZERO)).max(200).default([])
});
export function loadConfig(): AppConfig {
 const override = process.env.AERODROME_CONFIG_PATH;
 if (override !== undefined && !path.isAbsolute(override)) throw new Error("AERODROME_CONFIG_PATH must be an absolute path.");
 const filename = override ?? fileURLToPath(new URL("../config.json", import.meta.url));
 let raw: unknown = {};
 try {
   if (fs.statSync(filename).size > 64000) throw new Error("Configuration too large.");
   raw = JSON.parse(fs.readFileSync(filename, "utf8"));
 } catch (error) {
   if ((error as NodeJS.ErrnoException).code === "ENOENT" && override === undefined) raw = {};
   else if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Configured configuration file is unavailable.");
   else if (error instanceof SyntaxError) throw new Error("Configuration is invalid.");
   else if (error instanceof Error && error.message === "Configuration too large.") throw error;
   else throw new Error("Configuration file is unavailable.");
 }
 let input: z.infer<typeof configSchema>;
 try { input = configSchema.parse(raw); } catch { throw new Error("Configuration is invalid."); }
 return { ...publicConfig(), ...input, walletAddress: input.walletAddress ? getAddress(input.walletAddress) : undefined,
   veNftTokenIds: input.veNftTokenIds.map(value => BigInt(value).toString()), gaugeAddresses: uniqAddresses(input.gaugeAddresses.map(value => getAddress(value))) };
}
export function publicConfig(): AppConfig {
 return { veNftTokenIds: [], gaugeAddresses: [], baseRpcUrl: "https://mainnet.base.org",
 contracts: { voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5", router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", defaultFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" },
 tokens: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } };
}
export class WalletRequiredError extends Error { constructor() { super("WALLET_REQUIRED"); } }

export function zeroAddress(): Address { return ZERO; }
export function normalizeAddress(value: string, label = "address"): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address: ${value}`);
  return getAddress(value);
}

export function walletAddress(cfg: AppConfig): Address {
  if (!cfg.walletAddress) throw new WalletRequiredError();
  return normalizeAddress(cfg.walletAddress, "walletAddress");
}

export function voterAddress(cfg: AppConfig): Address {
  return normalizeAddress(cfg.contracts.voter, "contracts.voter");
}

export function routerAddress(cfg: AppConfig): Address {
  return normalizeAddress(cfg.contracts.router, "contracts.router");
}

export function defaultFactoryAddress(cfg: AppConfig): Address {
  return normalizeAddress(cfg.contracts.defaultFactory, "contracts.defaultFactory");
}

export function uniqAddresses(addresses: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const address of addresses) {
    const normalized = getAddress(address);
    const key = normalized.toLowerCase();
    if (normalized === ZERO) continue;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

export function uniqBigInts(values: bigint[]): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const value of values) {
    const key = value.toString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

export function veTokenIds(cfg: AppConfig): bigint[] {
  return uniqBigInts((cfg.veNftTokenIds ?? []).map((x) => BigInt(x)));
}
