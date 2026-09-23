import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeFunctionData,decodeAbiParameters,encodeFunctionData,encodeAbiParameters,parseAbiParameters} from 'viem';
import {simulationRequest} from './basket-simulation.js';
import {prepareUniversalBasketPlan,UNIVERSAL_ROUTER,universalAbi} from './universal-plan.js';
// @ts-ignore Browser module intentionally has no build dependency.
import {validateUniversalPlan} from '../web/plan-guard.js';
const code=JSON.parse(readFileSync(new URL('./fixtures/universal-code.json',import.meta.url),'utf8')).code;
const wallet='0x0000000000000000000000000000000000000001',tokens=['0x0000000000000000000000000000000000000002','0x0000000000000000000000000000000000000003'];
const expected={wallet,tokens,amounts:{[tokens[0]]:'1000',[tokens[1]]:'2000'}};
let allowance=0n,twoHops=false,wrongCode=false;
const rt:any={allowQuotes:false,fetch:async()=>{throw Error('No network allowed');},client:{getChainId:async()=>8453,getCode:async(a:any)=>{assert.equal(a.blockNumber,10n);assert.equal(a.address,UNIVERSAL_ROUTER);return wrongCode?'0x00':code},getBlock:async()=>({number:10n,hash:'0x'+'a'.repeat(64)}),readContract:async(a:any)=>{
 if(a.functionName==='balanceOf')return 1000000n;
 if(a.functionName==='decimals')return 6;
 if(a.functionName==='symbol')return 'TEST';
 if(a.functionName==='allowance'){assert.equal(a.args[1],UNIVERSAL_ROUTER);return allowance;}
 if(a.functionName==='getAmountsOut')return [a.args[0],...a.args[1].map(()=>twoHops&&a.args[1].length===2?3000000n:2000000n)];
}}};
const run=()=>prepareUniversalBasketPlan(expected,new AbortController().signal,rt);
let passed=0;
for(const a of [0n,1n,1000000n])for(const h of [false,true]){allowance=a;twoHops=h;const p=await run();assert.equal(validateUniversalPlan(p,expected),true);assert.equal(p.calls.filter(c=>c.kind==='UNIVERSAL_SWAP').length,1);assert.equal(p.calls.at(-1).kind,'UNIVERSAL_SWAP');passed++;}
allowance=1n;twoHops=false;const good=await run();
const mutateArgs=(p:any,fn:(args:any[])=>void)=>{const c=p.calls.at(-1);const decoded=decodeFunctionData({abi:universalAbi,data:c.data});const args:any[]=[...structuredClone(decoded.args!)];fn(args);c.data=encodeFunctionData({abi:universalAbi,functionName:'execute',args:args as any});};
const params=parseAbiParameters('address,uint256,uint256,bytes,bool,bool');
const mutateInput=(p:any,fn:(args:any[])=>void)=>mutateArgs(p,args=>{const input:any[]= [...decodeAbiParameters(params,args[1][0])];fn(input);args[1][0]=encodeAbiParameters(params,input as any)});
const bad:Array<[string,(p:any)=>void]>=[
 ['chain',p=>p.chainId=1],['wallet',p=>p.wallet=tokens[0]],['sending',p=>p.executable=true],['expiry',p=>p.expiresAt='2000-01-01'],['mode',p=>p.executionMode='OTHER'],['code hash',p=>p.routerCodeHash='0x00'],['router',p=>p.router=tokens[0]],
 ['amount',p=>p.tokens[0].amountRaw='999'],['min',p=>p.minimumOutput='1'],['duplicate',p=>p.tokens[1]=p.tokens[0]],['route',p=>p.tokens[0].routeTokens[1]=wallet],['approval target',p=>p.calls[0].to=wallet],['approval spender',p=>p.calls[0].spender=wallet],['missing reset',p=>p.calls.shift()],['extra',p=>p.calls.push(p.calls[0])],['reorder',p=>p.calls.reverse()],['value',p=>p.calls.at(-1).value='0x1'],['recipient',p=>p.calls.at(-1).recipient=tokens[0]],['swap target',p=>p.calls.at(-1).to=wallet],['suffix',p=>p.calls.at(-1).data+='00'],
 ['allow revert',p=>mutateArgs(p,a=>a[0]='0x8808')],['extra command',p=>mutateArgs(p,a=>a[0]='0x080808')],['missing input',p=>mutateArgs(p,a=>a[1].pop())],['deadline',p=>mutateArgs(p,a=>a[2]=1n)],
 ['input recipient',p=>mutateInput(p,a=>a[0]=tokens[0])],['input amount',p=>mutateInput(p,a=>a[1]=1n)],['input minimum',p=>mutateInput(p,a=>a[2]=1n)],['input path',p=>mutateInput(p,a=>a[3]='0x')],['payer',p=>mutateInput(p,a=>a[4]=false)],['uniswap flag',p=>mutateInput(p,a=>a[5]=true)]
];
for(const [label,fn] of bad){const p=structuredClone(good);fn(p);assert.throws(()=>validateUniversalPlan(p,expected),Error,label);passed++;}
const request:any=simulationRequest(good);const sequence=request.params[0].blockStateCalls[0].calls;
assert.equal(request.params[1],good.blockHash);
assert.ok(sequence[2].data.toLowerCase().endsWith(UNIVERSAL_ROUTER.slice(2).toLowerCase().padStart(64,'0')));assert.equal(sequence[5+good.calls.length-1].data,good.calls.at(-1).data);passed++;
wrongCode=true;await assert.rejects(run,/deployment/);passed++;
console.log(`PASS Universal Router: ${passed} cases; code pin, permission spender, independently reconstructed ABI, command flags, inputs, recipient, path, deadline, and sending gate. No network or signing.`);
