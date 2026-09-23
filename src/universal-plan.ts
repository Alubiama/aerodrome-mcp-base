import {createHash} from 'node:crypto';
import {decodeFunctionData,encodeFunctionData,encodeAbiParameters,parseAbi,parseAbiParameters,keccak256,type Hex} from 'viem';
import {prepareBasketPlan} from './basket-plan.js';
import {makeClient} from './client.js';
import {publicConfig} from './config.js';
import type {BasketRuntime} from './basket.js';
export const UNIVERSAL_ROUTER='0xcAF22ce31298CF2BF1D152862F80216478ad7c67';
export const UNIVERSAL_CODE_HASH='0xa11d1a13950f5b70dd0d7822e4e3b575778d8614e897c7810d7e6e9f310c017d';
export const universalAbi=parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
const classicAbi=parseAbi(['function swapExactTokensForTokens(uint256,uint256,(address from,address to,bool stable,address factory)[],address,uint256) returns (uint256[])']);
const approveAbi=parseAbi(['function approve(address,uint256) returns(bool)']);
const params=parseAbiParameters('address,uint256,uint256,bytes,bool,bool');
export async function prepareUniversalBasketPlan(raw:unknown,signal:AbortSignal,rt?:BasketRuntime){
 const runtime=rt??{client:makeClient(publicConfig(),{batchRpc:true,timeoutMs:10000,signal}),fetch,allowQuotes:false};
 // Reuse the quote/amount checks, but read permissions for the actual executor.
 const client=new Proxy(runtime.client,{get(target,key){if(key==='readContract')return (args:any)=>target.readContract(args.functionName==='allowance'?{...args,args:[args.args[0],UNIVERSAL_ROUTER]}:args);return Reflect.get(target,key);}});
 const legacy=await prepareBasketPlan(raw,signal,{...runtime,client});
 const blockNumber=BigInt(legacy.blockNumber);
 const code=await runtime.client.getCode({address:UNIVERSAL_ROUTER,blockNumber});
 if(!code||keccak256(code)!==UNIVERSAL_CODE_HASH)throw Error('Universal Router deployment could not be verified');
 if((await runtime.client.getBlock({blockNumber})).hash!==legacy.blockHash)throw Error('Block changed');
 signal.throwIfAborted();
 const inputs:Hex[]=[],approvals:any[]=[],tokens:any[]=[];
 for(const call of legacy.calls){
  if(call.kind!=='SWAP'){
   approvals.push({...call,spender:UNIVERSAL_ROUTER,data:encodeFunctionData({abi:approveAbi,functionName:'approve',args:[UNIVERSAL_ROUTER,BigInt(call.amountRaw)]})});continue;
  }
  const {args}=decodeFunctionData({abi:classicAbi,data:call.data});
  const [amount,min,hops,recipient,deadline]=args;
  const token=legacy.tokens.find(t=>t.token.toLowerCase()===call.token.toLowerCase())!;
  const path=[hops[0].from,...hops.map(h=>h.to)];
  if(hops.some(h=>h.stable||h.factory.toLowerCase()!=='0x420dd381b31aef6683db6b902084cb0ffece40da')||hops.some((h,i)=>h.from.toLowerCase()!==path[i].toLowerCase()))throw Error('Unsupported path');
  const packed=(path[0]+path.slice(1).map(t=>'00'+t.slice(2)).join('')) as Hex;
  inputs.push(encodeAbiParameters(params,[recipient,amount,min,packed,true,false]));
  tokens.push({...token,routeTokens:path});
  if(deadline!==BigInt(Date.parse(legacy.expiresAt)/1000))throw Error('Deadline mismatch');
 }
 const commands=('0x'+'08'.repeat(tokens.length)) as Hex;
 const calls=[...approvals,{kind:'UNIVERSAL_SWAP',to:UNIVERSAL_ROUTER,value:'0x0',recipient:legacy.wallet,data:encodeFunctionData({abi:universalAbi,functionName:'execute',args:[commands,inputs,BigInt(Date.parse(legacy.expiresAt)/1000)]})}];
 const {planId:_,...base}=legacy;
 const plan={...base,tokens,calls,router:UNIVERSAL_ROUTER,routerCodeHash:UNIVERSAL_CODE_HASH,executionMode:'APPROVALS_THEN_UNIVERSAL_SWAP',simulation:{status:'NOT_SIMULATED',gas:null,reason:'Exact permissions followed by one router transaction. Sending is disabled pending deployment audit mapping and wallet verification.'},warnings:['Approvals are separate transactions and remain if the swap fails. Failed transactions still cost gas.','One strict router transaction contains every swap; allow-revert flags are disabled.','Existing sufficient allowances are retained. New approvals are exact.','Minimum output excludes gas. Independent quotes can interact. No signing or broadcasting.']};
 if(Date.parse(plan.expiresAt)<=Date.now())throw Error('Plan expired while preparing');
 return {...plan,planId:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}
