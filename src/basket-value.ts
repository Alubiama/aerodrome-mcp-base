import {formatUnits,parseUnits,type Address,type Hex} from 'viem';
import {publicActionsL2} from 'viem/op-stack';
import {classicQuote,QUOTE_WETH} from './aerodrome-quote.js';
import {makeClient} from './client.js';
import {publicConfig} from './config.js';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const WEI=10n**18n,USDC_UNIT=10n**6n;
type Call={to:string;data:string;value:string};
type BasketValueInput={wallet:string;blockNumber:string;blockHash:string;expiresAt:string;calls:Call[]};
type SimulatedValue={receivedUsdc:string;gasUsedRaw:string;callGasUsedRaw?:string[];status:string};
export type ValueDecision={status:'ESTIMATED'|'UNKNOWN';reason:string|null;grossUsdc:string;estimatedNetworkFeeUsdc:string|null;estimatedNetUsdc:string|null;worthCollecting:boolean|null;feeEth:string|null;gasPriceWei:string|null;priceUsdcPerEth:string|null;asOf:string;limitations:string[]};
export function calculateBasketValue(grossRaw:bigint,gasPriceWei:bigint,gasUnits:bigint[],l1Fees:bigint[],operatorFees:bigint[],priceUsdcPerEthRaw:bigint):{feeWei:bigint;feeUsdcRaw:bigint;netUsdcRaw:bigint}{
 if(grossRaw<0n||gasPriceWei<=0n||priceUsdcPerEthRaw<=0n||!gasUnits.length||gasUnits.length!==l1Fees.length||gasUnits.length!==operatorFees.length||[...gasUnits,...l1Fees,...operatorFees].some(x=>x<0n))throw Error('Invalid fee evidence');
 const feeWei=gasUnits.reduce((s,x)=>s+x,0n)*gasPriceWei+l1Fees.reduce((s,x)=>s+x,0n)+operatorFees.reduce((s,x)=>s+x,0n);
 const feeUsdcRaw=(feeWei*priceUsdcPerEthRaw+WEI-1n)/WEI; // round cost upward
 return {feeWei,feeUsdcRaw,netUsdcRaw:grossRaw-feeUsdcRaw};
}
export async function estimateBasketValue(plan:BasketValueInput,simulation:SimulatedValue,signal:AbortSignal,providedClient?:any):Promise<ValueDecision>{
 const asOf=new Date().toISOString(),grossRaw=parseUnits(simulation.receivedUsdc,6);
 const base={grossUsdc:formatUnits(grossRaw,6),asOf,limitations:['Estimate for the selected basket only. Network fees and pool prices can change.','Approvals are separate transactions. A failed swap can still spend gas.','Simulation uses validation=false; nonce, gas affordability, wallet prompts, and transaction inclusion are unverified.']};
 const unknown=(reason:string):ValueDecision=>({status:'UNKNOWN',reason,...base,estimatedNetworkFeeUsdc:null,estimatedNetUsdc:null,worthCollecting:null,feeEth:null,gasPriceWei:null,priceUsdcPerEth:null});
 if(simulation.status!=='SEQUENCE_SIMULATED'||Date.parse(plan.expiresAt)<=Date.now()||plan.calls.length<1||plan.calls.length>11)return unknown('Simulation missing or plan expired.');
 if(!/^0x[0-9a-fA-F]{64}$/.test(plan.blockHash))return unknown('Quote block hash unavailable.');
 if(!Array.isArray(simulation.callGasUsedRaw)||simulation.callGasUsedRaw.length!==plan.calls.length)return unknown('Per-transaction gas evidence unavailable.');
 try{
  signal.throwIfAborted();
  const feeSignal=AbortSignal.any([signal,AbortSignal.timeout(7000)]);
  const client=providedClient??makeClient(publicConfig(),{batchRpc:true,timeoutMs:6500,signal:feeSignal}).extend(publicActionsL2());
  const gasUnits=simulation.callGasUsedRaw.map(x=>{if(!/^\d{1,20}$/.test(x))throw Error('Malformed gas');return BigInt(x)});
  if(gasUnits.reduce((s,x)=>s+x,0n)!==BigInt(simulation.gasUsedRaw))return unknown('Gas totals disagree.');
  const block=await client.getBlock({blockNumber:BigInt(plan.blockNumber)});
  if(block.number!==BigInt(plan.blockNumber)||!block.hash||block.hash.toLowerCase()!==plan.blockHash.toLowerCase())return unknown('Quote block changed.');
  const requests=plan.calls.map(c=>({account:plan.wallet as Address,to:c.to as Address,data:c.data as Hex,value:BigInt(c.value)}));
  const [gasPrice,quote,...feeParts]=await Promise.all([client.getGasPrice(),classicQuote(client,QUOTE_WETH,USDC,WEI,block.number,feeSignal),...requests.flatMap(req=>[client.estimateL1Fee(req),client.estimateOperatorFee(req)])]);
  signal.throwIfAborted();
  if(typeof gasPrice!=='bigint'||gasPrice<=0n||!quote?.amountOut)return unknown('Gas price or WETH/USDC conversion unavailable.');
  const l1Fees=feeParts.filter((_,i)=>i%2===0) as bigint[],operatorFees=feeParts.filter((_,i)=>i%2===1) as bigint[];
  if([...l1Fees,...operatorFees].some(x=>typeof x!=='bigint'||x<0n))return unknown('Network fee component unavailable.');
  const value=calculateBasketValue(grossRaw,gasPrice,gasUnits,l1Fees,operatorFees,quote.amountOut);
  if(Date.parse(plan.expiresAt)<=Date.now())return unknown('Estimate expired.');
  return {status:'ESTIMATED',reason:null,...base,estimatedNetworkFeeUsdc:formatUnits(value.feeUsdcRaw,6),estimatedNetUsdc:formatUnits(value.netUsdcRaw,6),worthCollecting:value.netUsdcRaw>0n,feeEth:formatUnits(value.feeWei,18),gasPriceWei:gasPrice.toString(),priceUsdcPerEth:formatUnits(quote.amountOut,6)};
 }catch(e){if(signal.aborted)throw e;return unknown('Complete network fee estimate unavailable.');}
}
