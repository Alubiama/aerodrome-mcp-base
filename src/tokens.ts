import { formatUnits, getAddress, type Address } from "viem";
import { erc20Abi } from "./abi.js";
import type { TokenMeta } from "./types.js";

const cache = new Map<string, TokenMeta>();
const BASE_USDC_META: TokenMeta = {
  address: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  symbol: "USDC",
  decimals: 6
};

async function getBaseUsdcMeta(client: any, blockNumber?: bigint): Promise<TokenMeta> {
  let symbolFetched = false;
  let fetchedSymbol: unknown;
  try {
    fetchedSymbol = await client.readContract({
      address: BASE_USDC_META.address,
      abi: erc20Abi,
      functionName: "symbol",
      ...(blockNumber === undefined ? {} : { blockNumber })
    });
    symbolFetched = true;
  } catch {
    // Canonical metadata remains pinned if the display getter is unavailable.
  }
  if (symbolFetched && fetchedSymbol !== BASE_USDC_META.symbol) {
    throw new Error(`Base USDC symbol mismatch: RPC returned ${String(fetchedSymbol)}, expected USDC.`);
  }

  let decimalsFetched = false;
  let fetchedDecimals: unknown;
  try {
    fetchedDecimals = await client.readContract({
      address: BASE_USDC_META.address,
      abi: erc20Abi,
      functionName: "decimals",
      ...(blockNumber === undefined ? {} : { blockNumber })
    });
    decimalsFetched = true;
  } catch {
    // Canonical metadata remains pinned if the display getter is unavailable.
  }
  if (decimalsFetched && Number(fetchedDecimals) !== BASE_USDC_META.decimals) {
    throw new Error(`Base USDC decimals mismatch: RPC returned ${String(fetchedDecimals)}, expected 6.`);
  }

  return BASE_USDC_META;
}

export async function getTokenMeta(client: any, address: Address, symbolFallback?: string, blockNumber?: bigint): Promise<TokenMeta> {
  const key = address.toLowerCase();
  if (key === BASE_USDC_META.address.toLowerCase()) return getBaseUsdcMeta(client, blockNumber);

  const cached = cache.get(key);
  if (blockNumber === undefined && cached) return cached;

  let symbol = symbolFallback ?? address.slice(0, 6);
  let decimals = 18;

  try {
    const fetched = await client.readContract({ address, abi: erc20Abi, functionName: "symbol", ...(blockNumber === undefined ? {} : { blockNumber }) }) as string;
    const normalized = typeof fetched === "string" ? fetched.trim() : "";
    if (normalized.length >= 1 && normalized.length <= 32 && !/[\u0000-\u001f\u007f]/.test(normalized)) symbol = normalized;
  } catch {
    // non-standard symbol() — fallback is OK for display only
  }
  try {
    const fetched = Number(await client.readContract({ address, abi: erc20Abi, functionName: "decimals", ...(blockNumber === undefined ? {} : { blockNumber }) }));
    if (Number.isInteger(fetched) && fetched >= 0 && fetched <= 36) decimals = fetched;
  } catch {
    // non-standard decimals() — 18 is a safer display fallback than failing the whole scan
  }

  const meta = { address, symbol, decimals };
  if (blockNumber === undefined) cache.set(key, meta);
  return meta;
}

export function formatTokenAmount(raw: bigint, meta: TokenMeta): string {
  return `${formatUnits(raw, meta.decimals)} ${meta.symbol}`;
}

export function symbolForAddress(address: Address, knownTokens: Record<string, string>): string | undefined {
  const lower = address.toLowerCase();
  for (const [symbol, value] of Object.entries(knownTokens)) {
    if (value.toLowerCase() === lower) return symbol;
  }
  return undefined;
}
