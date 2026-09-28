import {classicQuote,CLASSIC_ROUTER,QUOTE_WETH} from './aerodrome-quote.js';
import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import * as z from 'zod/v4';
import { publicConfig } from './config.js';
import { makeClient } from './client.js';
import { erc20Abi } from './abi.js';
import { createHash } from 'node:crypto';

const address = z.string().refine(x => isAddress(x) && !/^0x0{40}$/i.test(x)).transform(x => getAddress(x));
const tokens = z.array(address).max(16).refine(xs => new Set(xs.map(x => x.toLowerCase())).size === xs.length);
export const inventoryInput = z.strictObject({ wallet: address, tokens: tokens.optional(), offset:z.number().int().min(0).max(50000).default(0), inventoryId:z.string().regex(/^[a-f0-9]{64}$/).optional(), refreshDiscovery:z.boolean().default(false) }).refine(x=>x.offset===0||!!x.inventoryId,{message:'A continuation requires its inventory ID'}).refine(x=>!x.refreshDiscovery||x.offset===0,{message:'Refresh starts from the first page'});
export const basketQuoteInput = z.strictObject({ wallet: address, tokens: tokens.min(1), destination: z.enum(['USDC', 'ETH']), provider:z.enum(['KYBERSWAP','AERODROME']).default('KYBERSWAP'), amounts:z.record(z.string().regex(/^0x[0-9a-f]{40}$/),z.string().regex(/^[1-9][0-9]{0,77}$/).refine(x=>BigInt(x)<(1n<<256n))).optional() });
const USDC = getAddress(publicConfig().tokens.USDC);
const WETH = '0x4200000000000000000000000000000000000006' as Address;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export type BasketRuntime = { client: ReturnType<typeof makeClient>; fetch: typeof fetch; allowQuotes: boolean; inventorySnapshots?:Map<string,InventorySnapshot>; discoveryTimeoutMs?:number };
const MAX_UINT256=(1n<<256n)-1n;
const QUOTE_MAX_AGE_MS=60_000;
export function basketBinding(wallet:string,destination:string,rows:{token:string;amountRaw:string|null}[],createdAt:number,now=Date.now()) {
 const canonical=JSON.stringify({chainId:8453,wallet:wallet.toLowerCase(),destination,inputs:rows.map(r=>({token:r.token.toLowerCase(),amountRaw:r.amountRaw})).sort((a,b)=>a.token.localeCompare(b.token))});
 return {basketKey:createHash('sha256').update(canonical).digest('hex'),expiresAt:new Date(createdAt+QUOTE_MAX_AGE_MS).toISOString(),expired:now>=createdAt+QUOTE_MAX_AGE_MS,executable:false as const};
}
function runtime(signal: AbortSignal): BasketRuntime {
 return {client: makeClient(publicConfig(), {batchRpc:true, timeoutMs:10000, signal}), fetch, allowQuotes:process.env.AERODROME_KYBER_QUOTES === 'approved', inventorySnapshots};
}
export async function boundedJson(response: Response) {
 if(!response.ok) throw Error('Provider unavailable');
 if(Number(response.headers.get('content-length'))>2_000_000) {await response.body?.cancel(); throw Error('Response too large');}
 const reader=response.body?.getReader(); if(!reader) throw Error('Empty response');
 const chunks:Uint8Array[]=[];let size=0;
 try {while(true) {const next=await reader.read(); if(next.done)break; size+=next.value.length;if(size>2_000_000)throw Error('Response too large');chunks.push(next.value);}} catch(e){await reader.cancel();throw e;} finally {reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
type Row={token:Address;symbol:string;decimals:number|null;amountRaw:string|null;amountFormatted:string|null;status:string};
async function balances(wallet:Address, addresses:Address[], blockNumber:bigint, signal:AbortSignal, rt:BasketRuntime) {
 const readOne=async(token:Address):Promise<Row>=>{
  signal.throwIfAborted();
  const row:Row={token,symbol:token,decimals:null,amountRaw:null,amountFormatted:null,status:'READ_FAILED'};
  const reads=await Promise.allSettled([
   rt.client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[wallet],blockNumber}),
   rt.client.readContract({address:token,abi:erc20Abi,functionName:'decimals',blockNumber}),
   rt.client.readContract({address:token,abi:erc20Abi,functionName:'symbol',blockNumber})
  ]);
  signal.throwIfAborted();
  if(reads[2].status==='fulfilled' && typeof reads[2].value==='string')row.symbol=reads[2].value.slice(0,64);
  if(reads[0].status==='fulfilled' && typeof reads[0].value==='bigint' && reads[0].value>=0n && reads[0].value<=MAX_UINT256)row.amountRaw=reads[0].value.toString();
  if(reads[1].status==='fulfilled' && Number.isInteger(reads[1].value) && Number(reads[1].value)>=0 && Number(reads[1].value)<=36)row.decimals=Number(reads[1].value);
  if(row.amountRaw!==null && row.decimals!==null) {row.amountFormatted=formatUnits(BigInt(row.amountRaw),row.decimals);row.status=BigInt(row.amountRaw)>0n?'OBSERVED':'ZERO_BALANCE';}
  return row;
 };
 const rows:Row[]=[];
 for(let i=0;i<addresses.length;i+=4)rows.push(...await Promise.all(addresses.slice(i,i+4).map(readOne)));
 return rows;
}
async function anchor(rt:BasketRuntime) {if(await rt.client.getChainId()!==8453)throw Error('Wrong chain');return rt.client.getBlock();}
async function checkBlock(rt:BasketRuntime, block:{number:bigint;hash:string}) {if((await rt.client.getBlock({blockNumber:block.number})).hash!==block.hash)throw Error('Block changed');}
export class InventoryChangedError extends Error {}
type DiscoveryFailure={code:'RATE_LIMITED'|'TIMEOUT'|'UPSTREAM'|'INVALID_RESPONSE'|'NETWORK';retryable:boolean};
class DiscoveryHttpError extends Error {constructor(readonly status:number){super('Discovery provider unavailable');}}
class DiscoveryFormatError extends Error {}
const DISCOVERY_MAX_PAGES=20;
const DISCOVERY_MAX_ITEMS=1000;
function discoveryFailure(error:unknown,requestSignal:AbortSignal):DiscoveryFailure {
 if(requestSignal.aborted)return {code:'TIMEOUT',retryable:true};
 if(error instanceof DiscoveryHttpError)return {code:error.status===429?'RATE_LIMITED':'UPSTREAM',retryable:error.status===429||error.status>=500};
 if(error instanceof TypeError)return {code:'NETWORK',retryable:true};
 return {code:'INVALID_RESPONSE',retryable:false};
}
async function discoveryJson(url:URL,signal:AbortSignal,rt:BasketRuntime) {
 const response=await rt.fetch(url,{signal,redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new DiscoveryHttpError(response.status)}
 return boundedJson(response);
}
async function pagedDiscovery(wallet:Address,signal:AbortSignal,rt:BasketRuntime) {
 const items:unknown[]=[];const seen=new Set<string>();
 let next:Record<string,unknown>|null={};
 for(let page=0;next!==null&&page<DISCOVERY_MAX_PAGES;page++){
  const url=new URL(`https://base.blockscout.com/api/v2/addresses/${wallet}/tokens`);
  url.searchParams.set('type','ERC-20');
  if(Object.keys(next).length>8)throw new DiscoveryFormatError('Too many cursor fields');
  for(const [key,value] of Object.entries(next)){
   if(!/^[a-z][a-z0-9_]{0,31}$/.test(key)||key==='type')throw new DiscoveryFormatError('Invalid cursor key');
   if(value===null)continue;
   if((typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')||String(value).length>128)throw new DiscoveryFormatError('Invalid cursor value');
   url.searchParams.set(key,String(value));
  }
  const cursor=url.search;
  if(seen.has(cursor))throw new DiscoveryFormatError('Repeated cursor');
  seen.add(cursor);
  const body=await discoveryJson(url,signal,rt);
  if(!body||typeof body!=='object'||Array.isArray(body)||!Array.isArray((body as any).items))throw new DiscoveryFormatError('Invalid page');
  const pageItems=(body as any).items as unknown[];
  if(!pageItems.length&&((body as any).next_page_params??null)!==null)throw new DiscoveryFormatError('Empty continuation');
  items.push(...pageItems);
  if(items.length>DISCOVERY_MAX_ITEMS)throw new DiscoveryFormatError('Inventory exceeds limit');
  const cursorData=(body as any).next_page_params;
  if(cursorData===null)next=null;
  else if(cursorData&&typeof cursorData==='object'&&!Array.isArray(cursorData))next=cursorData as Record<string,unknown>;
  else throw new DiscoveryFormatError('Invalid next page');
 }
 if(next!==null)throw new DiscoveryFormatError('Inventory pages exceed limit');
 return items;
}
async function discoverInventory(wallet:Address,signal:AbortSignal,rt:BasketRuntime) {
 const timeout=rt.discoveryTimeoutMs??10_000;
 const primarySignal=AbortSignal.any([signal,AbortSignal.timeout(timeout)]);
 try {
  const url=new URL(`https://base.blockscout.com/api/v2/addresses/${wallet}/token-balances`);
  const data=await discoveryJson(url,primarySignal,rt);
  if(!Array.isArray(data))throw new DiscoveryFormatError('Invalid inventory');
  return {data,failure:null,source:'ALL' as const};
 }catch(e){
  signal.throwIfAborted();
  const failure=discoveryFailure(e,primarySignal);
  if(!failure.retryable||failure.code==='RATE_LIMITED')return {data:[],failure,source:null};
 }
 // A complete token list can span 20 sequential pages; keep this within the 45s inventory request budget.
 const pageSignal=AbortSignal.any([signal,AbortSignal.timeout(rt.discoveryTimeoutMs??25_000)]);
 try {return {data:await pagedDiscovery(wallet,pageSignal,rt),failure:null,source:'PAGED' as const}}
 catch(e){signal.throwIfAborted();return {data:[],failure:discoveryFailure(e,pageSignal),source:null}}
}
export const INVENTORY_PAGE_SIZE=16;
type Candidate={token:Address;price:number|null;suspectedSpam:boolean;spamReason:string|null};
type InventorySnapshot={inventoryId:string;candidates:Candidate[];expiresAt:number};
const INVENTORY_SNAPSHOT_MS=10*60_000;
const inventorySnapshots=new Map<string,InventorySnapshot>();
function recentSnapshot(store:Map<string,InventorySnapshot>|undefined,wallet:Address) {
 const key=wallet.toLowerCase(),snapshot=store?.get(key);
 if(snapshot&&snapshot.expiresAt<=Date.now()){store?.delete(key);return undefined}
 return snapshot;
}
function rememberSnapshot(store:Map<string,InventorySnapshot>|undefined,wallet:Address,snapshot:InventorySnapshot) {
 if(!store||snapshot.candidates.length>1000)return;
 const key=wallet.toLowerCase();store.delete(key);
 for(const [oldKey,old] of store)if(old.expiresAt<=Date.now())store.delete(oldKey);
 if(store.size>=64)store.delete(store.keys().next().value!);
 store.set(key,snapshot);
}
export function suspiciousMetadata(value:unknown) {
 return typeof value==='string' && /https?:\/\/|www\.|t\.me\/|visit\b.{0,80}\bclaim|claim\b.{0,80}\bairdrop/i.test(value);
}
export function impersonatesCoreToken(token:string,symbol:unknown) {
 if(typeof symbol!=='string')return false;
 const name=symbol.trim().toUpperCase();
 return name==='USDC'&&token.toLowerCase()!==USDC.toLowerCase()||name==='WETH'&&token.toLowerCase()!==WETH.toLowerCase();
}
export function inventoryCandidates(data:unknown,manual:Address[]=[]) {
 if(!Array.isArray(data))throw Error('Invalid inventory');
 const map=new Map<string,Candidate>();
 for(const token of [...manual,USDC,WETH])map.set(token.toLowerCase(),{token,price:null,suspectedSpam:false,spamReason:null});
 for(const item of data) {
  const raw=item?.token?.address_hash;
  if(item?.token?.type!=='ERC-20'||typeof raw!=='string'||!isAddress(raw)||/^0x0{40}$/i.test(raw)||typeof item.value!=='string'||!/^\d{1,78}$/.test(item.value)||BigInt(item.value)===0n||BigInt(item.value)>MAX_UINT256)continue;
  const token=getAddress(raw);const key=token.toLowerCase();
  const price=typeof item.token.exchange_rate==='string'||typeof item.token.exchange_rate==='number'?Number(item.token.exchange_rate):NaN;
  const impersonation=impersonatesCoreToken(token,item.token.symbol);
  const suspicious=suspiciousMetadata(item.token.symbol)||suspiciousMetadata(item.token.name)||impersonation;
  const existing=map.get(key);
  map.set(key,{token,price:Number.isFinite(price)&&price>0?price:existing?.price??null,suspectedSpam:suspicious||existing?.suspectedSpam===true,spamReason:impersonation?'This contract uses the symbol of a different known Base token. Check its contract address.':suspicious?'Token metadata contains a promotional link or claim instruction. This is a heuristic, not a security verdict.':existing?.spamReason??null});
 }
 return [...map.values()].sort((a,b)=>Number(a.suspectedSpam)-Number(b.suspectedSpam)||Number(b.price!==null)-Number(a.price!==null)||a.token.toLowerCase().localeCompare(b.token.toLowerCase()));
}
export async function readBasketInventory(raw:unknown, signal:AbortSignal, rt=runtime(signal)) {
 const input=inventoryInput.parse(raw);const warnings=['All valid nonzero ERC-20 entries returned by the indexer are candidates, including entries without prices. This is source coverage, not proof of every asset on Base.','Balances are verified in pages of 16. Pages may have different block times; selected balances are refreshed before quoting.','Estimated values use an unverified indexer price and an on-chain balance; they are not sale quotes. Suspicious metadata flags are only heuristics.'];
 let data:unknown=[];let discoveryStatus:'INDEXER_CANDIDATES'|'CACHED_CANDIDATES'|'MANUAL'|'UNAVAILABLE'=input.tokens?.length?'MANUAL':'INDEXER_CANDIDATES';
 let discoveryFailure:DiscoveryFailure|null=null;
 const snapshot=input.tokens?.length?undefined:recentSnapshot(rt.inventorySnapshots,input.wallet);
 let candidates:Candidate[];
 if(!input.tokens?.length){
  if(snapshot&&(input.offset>0||!input.refreshDiscovery)){
   if(input.offset>0&&input.inventoryId!==snapshot.inventoryId)throw new InventoryChangedError('Inventory changed; reload from the first page');
   candidates=snapshot.candidates;discoveryStatus='CACHED_CANDIDATES';warnings.push('Using a recent token list held briefly in server memory. Balances are checked again on Base RPC.');
  }else{
   const discovery=await discoverInventory(input.wallet,signal,rt);data=discovery.data;discoveryFailure=discovery.failure;
   if(discovery.source==='PAGED')warnings.push('The all-balances indexer request failed; token candidates were recovered through its complete paginated ERC-20 list.');
   if(discoveryFailure){
    if(snapshot&&discoveryFailure.code!=='INVALID_RESPONSE'){
     candidates=snapshot.candidates;discoveryStatus='CACHED_CANDIDATES';warnings.push('The indexer could not refresh the token list. Using a recent list; balances are checked again on Base RPC.');
    }else{discoveryStatus='UNAVAILABLE';warnings.push('Discovery is unavailable. Only core tokens are shown; retry discovery or add token addresses.');candidates=inventoryCandidates([])}
   }else candidates=inventoryCandidates(data);
  }
 }else candidates=inventoryCandidates([],input.tokens);
 const inventoryId=createHash('sha256').update(JSON.stringify({wallet:input.wallet.toLowerCase(),mode:discoveryStatus==='CACHED_CANDIDATES'?'INDEXER_CANDIDATES':discoveryStatus,tokens:candidates.map(x=>x.token.toLowerCase())})).digest('hex');
 if(input.offset>0&&(input.inventoryId!==inventoryId||input.offset>=candidates.length))throw new InventoryChangedError('Inventory changed; reload from the first page');
 if(discoveryStatus==='INDEXER_CANDIDATES')rememberSnapshot(rt.inventorySnapshots,input.wallet,{inventoryId,candidates,expiresAt:Date.now()+INVENTORY_SNAPSHOT_MS});
 const page=candidates.slice(input.offset,input.offset+INVENTORY_PAGE_SIZE);
 const block=await anchor(rt);const observed=await balances(input.wallet,page.map(x=>x.token),block.number,signal,rt);await checkBlock(rt,block);
 const rows=observed.map((row,i)=>{const candidate=page[i];const estimate=row.amountFormatted!==null&&candidate.price!==null?Number(row.amountFormatted)*candidate.price:NaN;const impersonation=impersonatesCoreToken(row.token,row.symbol);const suspicious=candidate.suspectedSpam||suspiciousMetadata(row.symbol)||impersonation;const riskLevel=suspicious?'BLOCKED_METADATA':row.token.toLowerCase()===USDC.toLowerCase()||row.token.toLowerCase()===WETH.toLowerCase()?'KNOWN_CONTRACT':'UNVERIFIED';return {...row,approximateUsd:Number.isFinite(estimate)&&estimate>=0?estimate:null,suspectedSpam:suspicious,riskLevel,spamReason:suspicious?candidate.spamReason??(impersonation?'This contract uses the symbol of a different known Base token. Check its contract address.':'Token symbol contains promotional instructions; review separately.'):null,blockNumber:block.number.toString()};});
 const next=input.offset+page.length;
 return {wallet:input.wallet,blockNumber:block.number.toString(),observedAt:new Date().toISOString(),rows,warnings,discoveryStatus,discoveryFailure,pagination:{offset:input.offset,nextOffset:next<candidates.length?next:null,totalCandidates:candidates.length,inventoryId}};
}
const uint256=z.string().regex(/^\d+$/).max(78).refine(x=>BigInt(x)<=MAX_UINT256);
const summarySchema=z.object({tokenIn:address,tokenOut:address,amountIn:uint256,amountOut:uint256});
export async function quoteBasket(raw:unknown, signal:AbortSignal, rt=runtime(signal)) {
 const input=basketQuoteInput.parse(raw);const block=await anchor(rt);
 const current=await balances(input.wallet,input.tokens,block.number,signal,rt);
 if(input.amounts){
  if(Object.keys(input.amounts).some(t=>!input.tokens.some(x=>x.toLowerCase()===t)))throw Error('Amount token not selected');
  for(const row of current){const amount=input.amounts[row.token.toLowerCase()];if(amount===undefined)continue;if(row.amountRaw===null||BigInt(amount)>BigInt(row.amountRaw)||row.decimals===null)throw Error('Amount exceeds verified balance');row.amountRaw=amount;row.amountFormatted=formatUnits(BigInt(amount),row.decimals);}
 }
 const quoteStartedAt=Date.now();
 const destination=input.destination==='USDC'?USDC:NATIVE;
 const rows=[];
 for(const row of current) {
  let status=row.status;let outputFormatted:string|null=null;let reason='';let amountOut:string|null=null;let route:unknown=null;
  if(row.status==='OBSERVED') {
   if(row.token.toLowerCase()===destination.toLowerCase()) {status='ALREADY_DESTINATION';reason='Already held in the output asset; excluded from the recovery total.';}
   else if(input.provider==='AERODROME') {
    if(input.destination==='ETH'&&row.token.toLowerCase()===QUOTE_WETH.toLowerCase()) {amountOut=row.amountRaw;outputFormatted=row.amountFormatted;status='INDICATIVE_QUOTE';route={kind:'UNWRAP_WETH'};reason='WETH unwrap is 1:1 before gas. Execution is not simulated.';}
    else {const quoted=await classicQuote(rt.client,row.token,input.destination==='ETH'?QUOTE_WETH:USDC,BigInt(row.amountRaw!),block.number,signal);
     if(quoted){amountOut=quoted.amountOut.toString();outputFormatted=formatUnits(quoted.amountOut,input.destination==='USDC'?6:18);status='INDICATIVE_QUOTE';route={kind:'CLASSIC_VOLATILE',router:CLASSIC_ROUTER,hops:quoted.routes,unwrapOutput:input.destination==='ETH'};reason='Best positive quote among classic volatile direct / USDC / WETH paths at the balance block. Stable pools and Slipstream are not searched. Before gas; not simulated.';}
     else {status='QUOTE_UNAVAILABLE';reason='No positive verified quote in the limited classic-pool search. This does not mean Aerodrome cannot swap this token.';}
    }
   }
   else if(!rt.allowQuotes) {status='PROVIDER_APPROVAL_REQUIRED';reason='Permission to send selected token addresses and amounts to KyberSwap is pending. No quote request was sent.';}
   else {
    try {
     const url=new URL('https://aggregator-api.kyberswap.com/base/api/v1/routes');
     url.search=new URLSearchParams({tokenIn:row.token,tokenOut:destination,amountIn:row.amountRaw!}).toString();
     const body=await boundedJson(await rt.fetch(url,{signal,redirect:'error'}));
     const parsed=z.object({code:z.literal(0),data:z.object({routeSummary:summarySchema})}).parse(body).data.routeSummary;
     if(parsed.tokenIn.toLowerCase()!==row.token.toLowerCase() || parsed.tokenOut.toLowerCase()!==destination.toLowerCase() || BigInt(parsed.amountIn)!==BigInt(row.amountRaw!))throw Error('Quote identity mismatch');
     if(BigInt(parsed.amountOut)<=0n){status='NO_POSITIVE_QUOTE';reason='Provider returned no positive output for this amount.';}
     else {amountOut=parsed.amountOut;outputFormatted=formatUnits(BigInt(amountOut),input.destination==='USDC'?6:18);status='INDICATIVE_QUOTE';reason='KyberSwap route quote; not a simulated sale or a guaranteed net amount.';}
    } catch {signal.throwIfAborted();status='QUOTE_UNAVAILABLE';reason='No verified quote response. This does not prove that the token cannot be swapped.';}
   }
  } else reason=row.status==='ZERO_BALANCE'?'No balance at the refreshed block.':'Balance or token decimals could not be verified.';
  rows.push({...row,status,outputFormatted,amountOutRaw:amountOut,reason,route,provider:input.provider});
 }
 await checkBlock(rt,block);
 const binding=basketBinding(input.wallet,input.destination,current,quoteStartedAt);
 if(binding.expired)for(const row of rows)if(row.status==='INDICATIVE_QUOTE'){row.status='QUOTE_EXPIRED';row.outputFormatted=null;row.amountOutRaw=null;row.reason='This preview expired while being prepared. Request a fresh preview.';}
 const complete=rows.every(r=>r.status==='INDICATIVE_QUOTE'||r.status==='ALREADY_DESTINATION');
 return {wallet:input.wallet,destination:input.destination,provider:input.provider,blockNumber:block.number.toString(),blockHash:block.hash,observedAt:new Date().toISOString(),binding,rows,
  totalOutputFormatted:complete?formatUnits(rows.reduce((sum,r)=>sum+BigInt(r.amountOutRaw??'0'),0n),input.destination==='USDC'?6:18):null,
  simulation:{status:'NOT_SIMULATED',reason:'A combined execution adapter and wallet capability checks are not implemented. Approvals, gas, shared-pool effects and net proceeds have not been simulated. No executable transaction is provided.'},
  warnings:[input.provider==='AERODROME'?'Balances and classic pool quotes use the same verified Base block. Route search excludes stable pools and Slipstream.':'Balances were refreshed before quoting. Quotes use the provider current state and are not pinned to the balance block.','Any total is the sum of separate indicative quotes before unmeasured network costs, not a combined basket quote.','No claims, wallet connection, signatures, approvals or transactions are performed. This basket covers liquid ERC-20 balances only.']};
}
