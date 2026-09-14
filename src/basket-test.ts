import assert from 'node:assert/strict';
import {inventoryCandidates,readBasketInventory,quoteBasket,inventoryInput,basketQuoteInput,boundedJson,basketBinding,type BasketRuntime} from './basket.js';
const wallet='0x0000000000000000000000000000000000000001';
const token='0x0000000000000000000000000000000000000002';
const usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
let fetches=0,mode='ok',changed=false;
const rt:BasketRuntime={allowQuotes:false,client:{
 getChainId:async()=>8453,
 getBlock:async(args?:unknown)=>({number:10n,hash:changed&&args?'0xb':'0xa'}),
 readContract:async({functionName}:any)=>{
  if(mode==='balanceFailure'&&functionName==='balanceOf')throw Error('private error');
  if(functionName==='balanceOf')return mode==='zero'?0n:1230000n;
  if(functionName==='decimals')return 6;
  if(functionName==='symbol')return '<script>untrusted</script>';
 }
} as any,fetch:(async(url:URL|string)=>{
 fetches++;const u=new URL(url);
 assert.equal(u.hostname,'aggregator-api.kyberswap.com');
 assert.equal(u.searchParams.has('wallet'),false);assert.equal(u.toString().includes(wallet),false);
 const summary={tokenIn:mode==='mismatch'?usdc:u.searchParams.get('tokenIn'),tokenOut:u.searchParams.get('tokenOut'),amountIn:u.searchParams.get('amountIn'),amountOut:'2000000'};
 return new Response(JSON.stringify({code:0,data:{routeSummary:summary}}));
}) as typeof fetch};
const signal=new AbortController().signal;
for(const value of [{wallet:'bad'},{wallet,tokens:[token,token]},{wallet,tokens:Array(17).fill(token)},{wallet,rpcUrl:'http://evil'}])assert.equal(inventoryInput.safeParse(value).success,false);
assert.equal(basketQuoteInput.safeParse({wallet,tokens:[],destination:'USDC'}).success,false);
const inventory=await readBasketInventory({wallet,tokens:[token]},signal,rt);
assert.equal(fetches,0);assert.equal(inventory.rows[0].amountFormatted,'1.23');
let result=await quoteBasket({wallet,tokens:[token],destination:'USDC'},signal,rt);
assert.equal(fetches,0,'approval gate sends no provider traffic');assert.equal(result.totalOutputFormatted,null);assert.equal(result.rows[0].status,'PROVIDER_APPROVAL_REQUIRED');
rt.allowQuotes=true;result=await quoteBasket({wallet,tokens:[token],destination:'USDC'},signal,rt);
assert.equal(result.totalOutputFormatted,'2');assert.equal(result.simulation.status,'NOT_SIMULATED');
assert.equal(result.binding.executable,false);assert.equal(result.binding.expired,false);
const original=basketBinding(wallet,'USDC',[{token,amountRaw:'123'}],1000,1000);
assert.equal(basketBinding(wallet,'USDC',[{token,amountRaw:'123'}],1000,60999).expired,false);
assert.equal(basketBinding(wallet,'USDC',[{token,amountRaw:'123'}],1000,61000).expired,true);
assert.notEqual(basketBinding(wallet,'ETH',[{token,amountRaw:'123'}],1000,1000).basketKey,original.basketKey);
assert.notEqual(basketBinding(wallet,'USDC',[{token,amountRaw:'124'}],1000,1000).basketKey,original.basketKey);
assert.notEqual(basketBinding(token,'USDC',[{token,amountRaw:'123'}],1000,1000).basketKey,original.basketKey);
mode='mismatch';result=await quoteBasket({wallet,tokens:[token],destination:'USDC'},signal,rt);assert.equal(result.totalOutputFormatted,null);assert.equal(result.rows[0].status,'QUOTE_UNAVAILABLE');
mode='balanceFailure';result=await quoteBasket({wallet,tokens:[token],destination:'ETH'},signal,rt);assert.equal(result.rows[0].amountRaw,null);assert.equal(result.totalOutputFormatted,null);
mode='zero';const before=fetches;result=await quoteBasket({wallet,tokens:[token],destination:'USDC'},signal,rt);assert.equal(fetches,before);assert.equal(result.rows[0].status,'ZERO_BALANCE');
mode='ok';result=await quoteBasket({wallet,tokens:[usdc],destination:'USDC'},signal,rt);assert.equal(result.totalOutputFormatted,'0');assert.equal(result.rows[0].status,'ALREADY_DESTINATION');
changed=true;await assert.rejects(()=>readBasketInventory({wallet,tokens:[token]},signal,rt),/Block changed/);changed=false;
const aborted=new AbortController();aborted.abort();await assert.rejects(()=>readBasketInventory({wallet,tokens:[token]},aborted.signal,rt));
await assert.rejects(()=>boundedJson(new Response('x',{headers:{'content-length':'2000001'}})),/too large/);
await assert.rejects(()=>boundedJson(new Response('x'.repeat(2000001))),/too large/);
console.log('PASS basket: input limits, pinned balance reads, permission gate, quote identity, missing balance, zero balance, output passthrough exclusion, reorg, abort, response limits.');

// More than the former 24-token cap, including unpriced and suspicious entries.
const candidateAddress=(i:number)=>('0x'+i.toString(16).padStart(40,'0')) as typeof token;
let source=Array.from({length:41},(_,i)=>({value:'999999999',token:{address_hash:candidateAddress(i+100),type:'ERC-20',symbol:i===40?'https://claim.invalid':'TOKEN',exchange_rate:i%2?'2':null}}));
const discoveryRt:BasketRuntime={...rt,fetch:(async()=>new Response(JSON.stringify(source))) as typeof fetch};
const candidates=inventoryCandidates([...source,source[0],null,{value:'1',token:{address_hash:token,type:'ERC-721'}}]);
assert.equal(candidates.length,43);assert.equal(candidates.filter(x=>x.suspectedSpam).length,1);
assert.ok(candidates.some(x=>x.token.toLowerCase()===candidateAddress(100)&&x.price===null));
let page=await readBasketInventory({wallet},signal,discoveryRt);
assert.equal(page.rows.length,16);assert.equal(page.pagination.totalCandidates,43);
assert.equal(page.rows.find(x=>x.approximateUsd!==null)?.approximateUsd,2.46,'valuation uses refreshed balance, not indexer quantity');
const id=page.pagination.inventoryId;const seen=page.rows.map(x=>x.token.toLowerCase());
while(page.pagination.nextOffset!==null){page=await readBasketInventory({wallet,offset:page.pagination.nextOffset,inventoryId:id},signal,discoveryRt);assert.ok(page.rows.length<=16);seen.push(...page.rows.map(x=>x.token.toLowerCase()));}
assert.equal(seen.length,43);assert.equal(new Set(seen).size,43);assert.ok(page.rows.some(x=>x.suspectedSpam));
await assert.rejects(()=>readBasketInventory({wallet:token,offset:16,inventoryId:id},signal,discoveryRt),/Inventory changed/);
source=source.slice(1);await assert.rejects(()=>readBasketInventory({wallet,offset:16,inventoryId:id},signal,discoveryRt),/Inventory changed/);
const unavailable=await readBasketInventory({wallet},signal,{...rt,fetch:(async()=>{throw Error('offline')}) as typeof fetch});
assert.equal(unavailable.discoveryStatus,'UNAVAILABLE');assert.equal(unavailable.pagination.totalCandidates,2);
assert.equal(inventoryInput.safeParse({wallet,offset:16}).success,false);
console.log('PASS inventory: 43 candidates across three pages, unpriced retention, deduplication, suspicious metadata, source/wallet binding, RPC valuation, explicit discovery failure.');
const {classicQuote,classicPaths}=await import('./aerodrome-quote.js');
assert.equal(classicPaths(token,usdc).length,2);
let calls=0;
const aeroRt:BasketRuntime={...rt,allowQuotes:false,client:{...rt.client,readContract:async(args:any)=>{if(args.functionName==='getAmountsOut'){calls++;assert.equal(args.blockNumber,10n);return args.args[1].length===1?[args.args[0],1000000n]:[args.args[0],400000n,1500000n]}return (rt.client.readContract as any)(args)}} as any,fetch:(async()=>{throw Error('Provider network must not be used')}) as typeof fetch};
const aero=await quoteBasket({wallet,tokens:[token],destination:'USDC',provider:'AERODROME'},signal,aeroRt);
assert.equal(aero.provider,'AERODROME');assert.equal(aero.totalOutputFormatted,'1.5');assert.equal(aero.simulation.status,'NOT_SIMULATED');assert.equal(calls,2);assert.equal((aero.rows[0].route as any).hops.length,2);
const badClient={readContract:async()=>[0n,999999n]};assert.equal(await classicQuote(badClient,token,usdc,123n,10n,signal),null);
const weth='0x4200000000000000000000000000000000000006';const unwrap=await quoteBasket({wallet,tokens:[weth],destination:'ETH',provider:'AERODROME'},signal,aeroRt);assert.equal((unwrap.rows[0].route as any).kind,'UNWRAP_WETH');assert.equal(calls,2);
console.log('PASS Aerodrome: pinned path comparison, best candidate, malformed response rejection, no aggregator traffic, WETH unwrap classification, simulation boundary.');
