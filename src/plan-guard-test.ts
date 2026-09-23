import assert from 'node:assert/strict';
import {encodeFunctionData,parseAbi} from 'viem';
import {prepareBasketPlan} from './basket-plan.js';
// @ts-ignore Browser module intentionally has no build dependency.
import {validateUnsignedPlan} from '../web/plan-guard.js';
const wallet='0x0000000000000000000000000000000000000001',tokens=['0x0000000000000000000000000000000000000002','0x0000000000000000000000000000000000000003'];
const expected={wallet,tokens,amounts:{[tokens[0]]:'1000',[tokens[1]]:'2000'}};
let allowance=0n,twoHops=false;
const rt:any={allowQuotes:false,fetch:async()=>{throw Error('No network allowed');},client:{getChainId:async()=>8453,getBlock:async()=>({number:10n,hash:'0xa'}),readContract:async(a:any)=>{
 if(a.functionName==='balanceOf')return 1000000n;
 if(a.functionName==='decimals')return 6;
 if(a.functionName==='symbol')return 'TEST';
 if(a.functionName==='allowance')return allowance;
 if(a.functionName==='getAmountsOut')return [a.args[0],...a.args[1].map(()=>twoHops&&a.args[1].length===2?3000000n:2000000n)];
}}};
const run=()=>prepareBasketPlan(expected,new AbortController().signal,rt);
let passed=0;
for(const a of [0n,1n,1000000n])for(const h of [false,true]){allowance=a;twoHops=h;assert.equal(validateUnsignedPlan(await run(),expected),true);passed++;}
allowance=1n;twoHops=false;const good=await run();
const swapAbi=parseAbi(['function swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)']);
const swap=(p:any)=>p.calls.find((c:any)=>c.kind==='SWAP');
const wordMutation=(p:any,index:number,value:string)=>{const c=swap(p),start=10+index*64;c.data=c.data.slice(0,start)+value.padStart(64,'0')+c.data.slice(start+64);};
const bad:Array<[string,(p:any)=>void]>=[
 ['chain',p=>p.chainId=1],['wallet',p=>p.wallet=tokens[0]],['executable',p=>p.executable=true],['expired',p=>p.expiresAt=new Date(Date.now()-1000).toISOString()],['far expiry',p=>p.expiresAt=new Date(Date.now()+999999).toISOString()],
 ['destination',p=>p.destination='ETH'],['provider',p=>p.provider='OTHER'],['slippage',p=>p.slippageBps=100],['duplicate token',p=>p.tokens[1]=p.tokens[0]],['amount',p=>p.tokens[0].amountRaw='999'],['minimum total',p=>p.minimumOutput='1'],['fake quoted minimum',p=>p.tokens[0].minimumOutput='0.1'],
 ['extra call',p=>p.calls.push(p.calls[0])],['missing reset',p=>p.calls.shift()],['reorder',p=>p.calls.reverse()],['native value',p=>swap(p).value='0x1'],['router',p=>swap(p).to=tokens[0]],['recipient metadata',p=>swap(p).recipient=tokens[0]],['spender',p=>p.calls[0].spender=wallet],['unlimited approval',p=>p.calls[1].data=p.calls[1].data.slice(0,-64)+'f'.repeat(64)],['calldata suffix',p=>swap(p).data+='00'],['selector',p=>swap(p).data='0xdeadbeef'+swap(p).data.slice(10)],
 ['calldata input',p=>wordMutation(p,0,'1')],['calldata min',p=>wordMutation(p,1,'1')],['dynamic offset',p=>wordMutation(p,2,'c0')],['recipient calldata',p=>wordMutation(p,3,tokens[0].slice(2))],['deadline calldata',p=>wordMutation(p,4,'1')],['route length',p=>wordMutation(p,5,'2')],['route from',p=>wordMutation(p,6,wallet.slice(2))],['route output',p=>wordMutation(p,7,wallet.slice(2))],['stable',p=>wordMutation(p,8,'1')],['factory',p=>wordMutation(p,9,wallet.slice(2))],
 ['unknown intermediary',p=>{const c=swap(p);c.data=encodeFunctionData({abi:swapAbi,functionName:'swapExactTokensForTokens',args:[1000n,1990000n,[[tokens[0] as any,wallet,false,'0x420DD381b31aEf6683db6B902084cB0FFECe40Da'],[wallet,'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',false,'0x420DD381b31aEf6683db6B902084cB0FFECe40Da']],wallet,BigInt(Date.parse(p.expiresAt)/1000)]});}],
];
for(const [label,mutate] of bad){const p=structuredClone(good);mutate(p);assert.throws(()=>validateUnsignedPlan(p,expected),Error,label);passed++;}
assert.throws(()=>validateUnsignedPlan(good,{...expected,amounts:{...expected.amounts,[wallet]:'1'}}));passed++;
console.log(`PASS plan guard: ${passed} cases using server-generated plans and malicious mutations. No network, signing, or execution. Structural consistency only; prices and atomic execution remain unverified.`);
