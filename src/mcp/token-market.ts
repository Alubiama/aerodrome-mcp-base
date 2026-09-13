import { getAddress, isAddress } from "viem";
import * as z from "zod/v4";

const MAX_TOKENS = 16, MAX_BYTES = 2 * 1024 * 1024;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const positiveNumericString = z.string().regex(/^\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value)) && Number(value) > 0);
export const tokenMarketCardSchema = z.strictObject({
  token: address, status: z.enum(["OBSERVED", "NOT_FOUND", "UNAVAILABLE"]), checkedAt: z.iso.datetime(), source: z.string(),
  pairAddress: address.nullable(), priceUsd: positiveNumericString.nullable(), liquidityUsd: z.number().finite().nonnegative().nullable(), volume24hUsd: z.number().finite().nonnegative().nullable(),
  priceChange24hPct: z.number().finite().nullable(), marketCapUsd: z.number().finite().nonnegative().nullable(), fdvUsd: z.number().finite().nonnegative().nullable(),
  projectLinks: z.array(z.string().url().refine(value => value.startsWith("https://"))).max(8)
});
export type TokenMarketCard = z.infer<typeof tokenMarketCardSchema>;

function normalizeTokens(tokens: string[]) {
  if (!Array.isArray(tokens) || tokens.length > MAX_TOKENS) throw new Error("Choose at most 16 distinct nonzero Base token addresses.");
  const normalized = tokens.map((token, index) => {
    if (!isAddress(token)) throw new Error(`tokens[${index}] is not an address.`);
    const value = getAddress(token);
    if (/^0x0{40}$/i.test(value)) throw new Error(`tokens[${index}] must be nonzero.`);
    return value;
  });
  if (new Set(normalized.map(value => value.toLowerCase())).size !== normalized.length) throw new Error("Token addresses must be distinct.");
  return normalized;
}
function finite(value: unknown, nonnegative = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || (nonnegative && value < 0)) return null;
  return value;
}
function price(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  return value;
}
function safeHttps(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
    return url.toString();
  } catch { return null; }
}
function links(pair: any): string[] {
  const raw = [...(Array.isArray(pair?.info?.websites) ? pair.info.websites.map((item: any) => item?.url) : []), ...(Array.isArray(pair?.info?.socials) ? pair.info.socials.map((item: any) => item?.url) : [])];
  const out: string[] = [];
  for (const value of raw) { const safe = safeHttps(value); if (safe && !out.includes(safe)) out.push(safe); if (out.length === 8) break; }
  return out;
}
async function readBounded(response: Response): Promise<string> {
  const header = Number(response.headers.get("content-length"));
  if (Number.isFinite(header) && header > MAX_BYTES) { await response.body?.cancel(); throw new Error("Response too large."); }
  if (!response.body) { const text = await response.text(); if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("Response too large."); return text; }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Response too large."); } chunks.push(part.value); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
function unavailable(token: string, checkedAt: string, source: string): TokenMarketCard { return { token, status: "UNAVAILABLE", checkedAt, source, pairAddress: null, priceUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPct: null, marketCapUsd: null, fdvUsd: null, projectLinks: [] }; }
function missing(token: string, checkedAt: string, source: string): TokenMarketCard { return { ...unavailable(token, checkedAt, source), status: "NOT_FOUND" }; }

/** Public market observation only. It does not follow returned links or infer value, APR, or trade advice. */
export async function getTokenMarketCards(tokens: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<TokenMarketCard[]> {
  signal?.throwIfAborted();
  const requested = normalizeTokens(tokens);
  if (requested.length === 0) return [];
  const source = `https://api.dexscreener.com/tokens/v1/base/${requested.map(value => value.toLowerCase()).join(",")}`;
  const checkedAt = new Date().toISOString();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10_000);
  const combined = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
  let payload: unknown;
  try {
    const response = await fetcher(source, { method: "GET", redirect: "error", signal: combined });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    payload = JSON.parse(await readBounded(response));
  } catch (error) {
    if (signal?.aborted) throw error;
    return requested.map(token => unavailable(token, checkedAt, source));
  } finally { clearTimeout(timer); }
  signal?.throwIfAborted();
  if (timeout.signal.aborted) return requested.map(token => unavailable(token, checkedAt, source));
  const pairs = Array.isArray(payload) ? payload : [];
  if (!Array.isArray(payload)) return requested.map(token => unavailable(token, checkedAt, source));
  return requested.map(token => {
    const candidates = pairs.filter((pair: any) => pair?.chainId === "base" && isAddress(pair?.pairAddress ?? "") && !/^0x0{40}$/i.test(pair.pairAddress) && typeof pair?.baseToken?.address === "string" && pair.baseToken.address.toLowerCase() === token.toLowerCase());
    candidates.sort((a: any, b: any) => (finite(b?.liquidity?.usd, true) ?? -1) - (finite(a?.liquidity?.usd, true) ?? -1) || String(a.pairAddress).toLowerCase().localeCompare(String(b.pairAddress).toLowerCase()));
    const pair = candidates[0];
    if (!pair) return missing(token, checkedAt, source);
    return tokenMarketCardSchema.parse({ token, status: "OBSERVED", checkedAt, source, pairAddress: getAddress(pair.pairAddress), priceUsd: price(pair.priceUsd), liquidityUsd: finite(pair?.liquidity?.usd, true), volume24hUsd: finite(pair?.volume?.h24, true), priceChange24hPct: finite(pair?.priceChange?.h24), marketCapUsd: finite(pair.marketCap, true), fdvUsd: finite(pair.fdv, true), projectLinks: links(pair) });
  });
}
