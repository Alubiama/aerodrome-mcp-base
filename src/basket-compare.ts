import {formatUnits,parseUnits} from 'viem';
import {planInput} from './basket-plan.js';
import {prepareUniversalBasketPlan} from './universal-plan.js';
import {simulateBasketPlan} from './basket-simulation.js';
import {estimateBasketValue,readBasketFeePricing} from './basket-value.js';
import {makeClient} from './client.js';
import {publicConfig} from './config.js';
import type {BasketRuntime} from './basket.js';
import {publicActionsL2} from 'viem/op-stack';

type CandidateResult={tokens:string[];excluded:string[];status:'ESTIMATED'|'UNKNOWN'|'UNVERIFIED';grossUsdc:string|null;networkFeeUsdc:string|null;netUsdc:string|null;gasPriceWei:string|null;priceUsdcPerEth:string|null;expiresAt:string|null;reason:string|null};
export const compareInput=planInput.refine(x=>x.tokens.length>=2&&x.tokens.length<=5,{message:'Select 2–5 input tokens to compare.'}).refine(x=>!x.tokens.some(t=>t.toLowerCase()==='0x833589fcD6eDb6e08f4c7c32d4f71b54bdA02913'.toLowerCase()),{message:'USDC is already the output asset.'});

export function leaveOneOutCandidates(tokens:string[]){
 if(tokens.length<2||tokens.length>5||new Set(tokens.map(x=>x.toLowerCase())).size!==tokens.length)throw Error('Select 2–5 distinct tokens');
 return [tokens,...tokens.map((_,i)=>tokens.filter((__,j)=>j!==i))];
}

export function summarizeBasketComparison(rows:CandidateResult[],now=Date.now()){
 const estimated=rows.filter(r=>r.status==='ESTIMATED'&&r.netUsdc!==null);
 const baselines=new Set(estimated.map(r=>`${r.gasPriceWei}:${r.priceUsdcPerEth}`));
 const valid=estimated.length>0&&baselines.size===1&&estimated.every(r=>r.expiresAt!==null&&Date.parse(r.expiresAt)>now);
 const ranked=valid?[...estimated].sort((a,b)=>{
  const delta=parseUnits(b.netUsdc!,6)-parseUnits(a.netUsdc!,6);
  return delta>0n?1:delta<0n?-1:0;
 }).slice(0,3):[];
 return {status:!valid?'INCOMPARABLE':estimated.length===rows.length?'COMPLETE_SAMPLED':'PARTIAL_SAMPLED',ranked:ranked.map(r=>({tokens:r.tokens,excluded:r.excluded,estimatedNetUsdc:r.netUsdc,deltaVsFullUsdc:rows[0]?.status==='ESTIMATED'&&rows[0].netUsdc!==null?formatUnits(parseUnits(r.netUsdc!,6)-parseUnits(rows[0].netUsdc,6),6):null})),coverage:'Full selection and every one-token omission only; other subsets were not evaluated.',limitations:['All candidates use one quote block, but this is a historical read-only simulation and a time-sensitive fee estimate.','A failed or unknown candidate cannot be ranked. The top results are among sampled candidates, not all possible subsets.','Validation=false does not verify wallet nonce, gas affordability, transaction inclusion, or actual payout.']};
}

export async function compareBasketCandidates(raw:unknown,signal:AbortSignal){
 const input=compareInput.parse(raw);
 const candidates=leaveOneOutCandidates(input.tokens);
 const client=makeClient(publicConfig(),{batchRpc:true,timeoutMs:10000,signal});
 if(await client.getChainId()!==8453)throw Error('Wrong chain');
 const block=await client.getBlock();
 if(!block.hash)throw Error('Anchor block unavailable');
 const feeClient=client.extend(publicActionsL2());
 const pricing=await readBasketFeePricing(client,block,signal);
 const pinned=new Proxy(client,{get(target,key){
  if(key==='getBlock')return (args:any)=>args?target.getBlock(args):Promise.resolve(block);
  return Reflect.get(target,key);
 }});
 const runtime:BasketRuntime={client:pinned,fetch,allowQuotes:false};
 const rows:CandidateResult[]=[];
 for(const tokens of candidates){
  signal.throwIfAborted();
  const excluded=input.tokens.filter(t=>!tokens.some(x=>x.toLowerCase()===t.toLowerCase()));
  try{
   const amounts=input.amounts?Object.fromEntries(Object.entries(input.amounts).filter(([token])=>tokens.some(x=>x.toLowerCase()===token))):undefined;
   const plan=await prepareUniversalBasketPlan({wallet:input.wallet,tokens,amounts},signal,runtime);
   if(plan.blockHash.toLowerCase()!==block.hash.toLowerCase())throw Error('Quote anchor drift');
   const sim=await simulateBasketPlan(plan,signal);
   if(sim.blockTag.toLowerCase()!==block.hash.toLowerCase())throw Error('Simulation anchor drift');
   const value=await estimateBasketValue(plan,sim,signal,feeClient,pricing);
   rows.push({tokens,excluded,status:value.status,grossUsdc:sim.receivedUsdc,networkFeeUsdc:value.estimatedNetworkFeeUsdc,netUsdc:value.estimatedNetUsdc,gasPriceWei:value.gasPriceWei,priceUsdcPerEth:value.priceUsdcPerEth,expiresAt:plan.expiresAt,reason:value.reason});
  }catch(error){
   if(signal.aborted)throw error;
   rows.push({tokens,excluded,status:'UNVERIFIED',grossUsdc:null,networkFeeUsdc:null,netUsdc:null,gasPriceWei:null,priceUsdcPerEth:null,expiresAt:null,reason:'Candidate quote or simulation could not be verified.'});
  }
 }
 const summary=summarizeBasketComparison(rows);
 return {wallet:input.wallet,chainId:8453,destination:'USDC',provider:'AERODROME',anchorBlockNumber:block.number.toString(),anchorBlockHash:block.hash,checkedAt:new Date().toISOString(),candidates:rows,...summary,executable:false};
}
