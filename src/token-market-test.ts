import assert from "node:assert/strict";
import { getTokenMarketCards, tokenMarketCardSchema } from "./mcp/token-market.js";

const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const A = token(1), B = token(2), C = token(3), P1 = token(10), P2 = token(11);
const response = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const pair = (patch: any = {}) => ({ chainId: "base", pairAddress: P1, baseToken: { address: A }, quoteToken: { address: B }, priceUsd: "1.25", liquidity: { usd: 10 }, volume: { h24: 3 }, priceChange: { h24: -2 }, marketCap: 20, fdv: 30, info: { websites: [{ url: "https://project.example" }], socials: [{ url: "http://bad.example" }, { url: "https://localhost/x" }] }, ...patch });

export async function testTokenMarket() {
  let seen = "";
  const cards = await getTokenMarketCards([A, B], undefined, async (url, init) => { seen = String(url); assert.equal(init?.redirect, "error"); return response([pair({ chainId: "ethereum" }), pair({ quoteToken: { address: A }, baseToken: { address: C } }), pair({ pairAddress: P2, liquidity: { usd: 20 } }), pair({ pairAddress: P1, liquidity: { usd: 20 } })]); });
  assert.match(seen, /^https:\/\/api\.dexscreener\.com\/tokens\/v1\/base\//); assert.equal(cards[0].pairAddress?.toLowerCase(), P1.toLowerCase()); assert.equal(cards[1].status, "NOT_FOUND"); tokenMarketCardSchema.parse(cards[0]);
  const invalid = await getTokenMarketCards([A], undefined, async () => response([pair({
    priceUsd: "-2", liquidity: { usd: "bad" }, volume: { h24: -1 }, marketCap: Infinity,
    info: { websites: [{ url: "javascript:alert(1)" }, { url: "https://ok.example" }] }
  })]));
  assert.equal(invalid[0].priceUsd, null); assert.equal(invalid[0].liquidityUsd, null); assert.equal(invalid[0].volume24hUsd, null); assert.deepEqual(invalid[0].projectLinks, ["https://ok.example/"]);
  const unavailable = await getTokenMarketCards([A], undefined, async () => response([], { status: 500 })); assert.equal(unavailable[0].status, "UNAVAILABLE");
  const huge = await getTokenMarketCards([A], undefined, async () => new Response("[]", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })); assert.equal(huge[0].status, "UNAVAILABLE");
  const controller = new AbortController(); controller.abort(); await assert.rejects(getTokenMarketCards([A], controller.signal, async () => response([])));
  await assert.rejects(getTokenMarketCards([A, A])); await assert.rejects(getTokenMarketCards([token(0)]));
  assert.equal((await getTokenMarketCards([A], undefined, async()=>response({ error: "invalid" })))[0].status,"UNAVAILABLE");
  const oversized = new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));c.close();}}));
  assert.equal((await getTokenMarketCards([A],undefined,async()=>oversized))[0].status,"UNAVAILABLE");
  assert.equal((await getTokenMarketCards([A],undefined,async()=>{throw new DOMException("timeout","TimeoutError");}))[0].status,"UNAVAILABLE");
  const during = new AbortController();
  await assert.rejects(getTokenMarketCards([A],during.signal,async()=>{during.abort();return response([]);}));
  const unsafe=["https://127.0.0.1", "https://169.254.169.254", "https://[::1]", "https://a.localhost", "https://user:pass@example.com", "http://example.com", "https://intranet"];
  assert.deepEqual((await getTokenMarketCards([A],undefined,async()=>response([pair({info:{websites:unsafe.map(url=>({url}))}})])))[0].projectLinks,[]);
  const caseToken=token(170);assert.equal((await getTokenMarketCards([caseToken],undefined,async()=>response([pair({baseToken:{address:caseToken.toUpperCase().replace("0X","0x")}})])))[0].status,"OBSERVED");
  assert.equal((await getTokenMarketCards([A],undefined,async()=>response([pair({pairAddress:token(0)})])))[0].status,"NOT_FOUND");
}

testTokenMarket().then(() => console.log("Token market tests passed.")).catch(error => { console.error(error); process.exit(1); });
