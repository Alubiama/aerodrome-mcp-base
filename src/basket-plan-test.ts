import assert from 'node:assert/strict';
import {decodeFunctionData,parseAbi} from 'viem';
import {prepareBasketPlan,planInput} from './basket-plan.js';
import {CLASSIC_ROUTER} from './aerodrome-quote.js';
import type {BasketRuntime} from './basket.js';
const wallet='0x0000000000000000000000000000000000000001',tokens=['0x0000000000000000000000000000000000000002','0x0000000000000000000000000000000000000003'];
let allowance=0n,fail=false,route=true,reads=0,reorg=false;
const rt:BasketRuntime={allowQuotes:false,fetch:(async()=>{throw Error('Unexpected provider request')}) as typeof fetch,client:{getChainId:async()=>8453,getBlock:async()=>({number:10n,hash:reorg&&++reads>2?'0xb':'0xa'}),readContract:async(a:any)=>{
 assert.equal(a.blockNumber,10n);
 if(a.functionName==='balanceOf')return 1000000n;
 if(a.functionName==='decimals')return 6;
 if(a.functionName==='symbol')return 'TEST';
 if(a.functionName==='allowance'){if(fail)throw Error('Allowance failed');return allowance}
 if(a.functionName==='getAmountsOut'){if(!route)throw Error('No pool');return [a.args[0],...a.args[1].map(()=>2000000n)]}
}} as any};
const signal=new AbortController().signal;
const run=()=>prepareBasketPlan({wallet,tokens},signal,rt);
let p=await run();assert.equal(p.executable,false);assert.equal(p.simulation.status,'NOT_SIMULATED');assert.equal(p.minimumOutput,'3.98');assert.deepEqual(p.calls.map(x=>x.kind),['EXACT_APPROVAL','SWAP','EXACT_APPROVAL','SWAP']);
const approve=decodeFunctionData({abi:parseAbi(['function approve(address,uint256)']),data:p.calls[0].data});assert.equal((approve.args as any)[0].toLowerCase(),CLASSIC_ROUTER.toLowerCase());assert.equal((approve.args as any)[1],1000000n);
const swap=decodeFunctionData({abi:parseAbi(['function swapExactTokensForTokens(uint256,uint256,(address from,address to,bool stable,address factory)[],address,uint256) returns (uint256[])']),data:p.calls[1].data});const args=swap.args as any;assert.equal(args[0],1000000n);assert.equal(args[1],1990000n);assert.equal(args[3],wallet);assert.equal(Number(args[4])*1000,Date.parse(p.expiresAt));
allowance=1n;p=await run();assert.deepEqual(p.calls.slice(0,3).map(x=>x.kind),['RESET_APPROVAL','EXACT_APPROVAL','SWAP']);
allowance=1000000n;p=await run();assert.deepEqual(p.calls.map(x=>x.kind),['SWAP','SWAP']);
fail=true;await assert.rejects(run,/Allowance failed/);fail=false;route=false;await assert.rejects(run,/Every input/);route=true;reorg=true;await assert.rejects(run,/Block changed/);
for(const raw of [{wallet,tokens:tokens.slice(0,1)},{wallet,tokens,provider:'KYBERSWAP'},{wallet,tokens,destination:'ETH'}])assert.equal(planInput.safeParse(raw).success,false);
console.log('PASS unsigned plan: calldata, exact/reset/existing allowances, recipient, minimum, deadline, failed routes/reads, reorg and strict inputs. No provider traffic or execution.');
reorg=false;reads=0;
const partial=await prepareBasketPlan({wallet,tokens,amounts:{[tokens[0]]:'1000',[tokens[1]]:'2000'}},signal,rt);
assert.deepEqual(partial.tokens.map(x=>x.amountRaw),['1000','2000']);
await assert.rejects(()=>prepareBasketPlan({wallet,tokens,amounts:{[tokens[0]]:'1000001'}},signal,rt),/exceeds/);
await assert.rejects(()=>prepareBasketPlan({wallet,tokens,amounts:{[wallet]:'100'}},signal,rt),/not selected/);
assert.equal(planInput.safeParse({wallet,tokens:[tokens[0],'0x4200000000000000000000000000000000000006']}).success,false);
console.log('PASS explicit input amounts: exact bounds, unknown token rejection, WETH cannot default to full balance.');
