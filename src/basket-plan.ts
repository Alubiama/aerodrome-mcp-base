import {encodeFunctionData,parseAbi,formatUnits} from 'viem';
import {createHash} from 'node:crypto';
import {basketQuoteInput,quoteBasket,type BasketRuntime} from './basket.js';
import {makeClient} from './client.js';
import {publicConfig} from './config.js';
import {CLASSIC_ROUTER} from './aerodrome-quote.js';
export const planInput=basketQuoteInput.omit({provider:true,destination:true}).refine(x=>x.tokens.length>=2&&x.tokens.length<=5,{message:'Select 2–5 input tokens.'}).refine(x=>!x.tokens.some(t=>t.toLowerCase()==='0x4200000000000000000000000000000000000006')||!!x.amounts?.['0x4200000000000000000000000000000000000006'],{message:'WETH requires an explicit amount.'});
const approvalAbi=parseAbi(['function allowance(address owner,address spender) view returns (uint256)','function approve(address spender,uint256 amount) returns (bool)']);
const swapAbi=parseAbi(['function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) returns (uint256[] amounts)']);
export async function prepareBasketPlan(raw:unknown,signal:AbortSignal,rt?:BasketRuntime){
 const input=planInput.parse(raw);const runtime=rt??{client:makeClient(publicConfig(),{batchRpc:true,timeoutMs:10000,signal}),fetch,allowQuotes:false};
 const quote=await quoteBasket({...input,destination:'USDC',provider:'AERODROME'},signal,runtime);
 if(quote.binding.expired||Date.parse(quote.binding.expiresAt)<=Date.now())throw Error('Fresh quotes required');
 if(quote.rows.some(r=>r.status!=='INDICATIVE_QUOTE'||(r.route as any)?.kind!=='CLASSIC_VOLATILE'))throw Error('Every input needs a positive Aerodrome route; exclude USDC, zero balances and unavailable tokens.');
 const blockNumber=BigInt(quote.blockNumber),block=await runtime.client.getBlock({blockNumber});
 if(block.hash!==quote.blockHash)throw Error('Block changed');
 const allowances=await Promise.all(quote.rows.map(r=>runtime.client.readContract({address:r.token,abi:approvalAbi,functionName:'allowance',args:[input.wallet,CLASSIC_ROUTER],blockNumber})));
 signal.throwIfAborted();const calls:any[]=[],tokens:any[]=[];let minimum=0n;
 const deadline=BigInt(Math.floor(Date.parse(quote.binding.expiresAt)/1000));
 for(let i=0;i<quote.rows.length;i++){
  const row=quote.rows[i],amount=BigInt(row.amountRaw!),out=BigInt(row.amountOutRaw!),allowance=allowances[i];
  if(typeof allowance!=='bigint'||allowance<0n||allowance>(1n<<256n)-1n)throw Error('Allowance could not be verified');
  const minOut=out*9950n/10000n;if(minOut<=0n)throw Error('Output too small for a nonzero minimum');minimum+=minOut;
  const approve=(value:bigint)=>calls.push({kind:value===0n?'RESET_APPROVAL':'EXACT_APPROVAL',token:row.token,spender:CLASSIC_ROUTER,amountRaw:value.toString(),to:row.token,value:'0x0',data:encodeFunctionData({abi:approvalAbi,functionName:'approve',args:[CLASSIC_ROUTER,value]})});
  if(allowance<amount){if(allowance>0n)approve(0n);approve(amount)}
  const route=row.route as any;calls.push({kind:'SWAP',token:row.token,to:CLASSIC_ROUTER,value:'0x0',amountInRaw:amount.toString(),minimumOutRaw:minOut.toString(),recipient:input.wallet,data:encodeFunctionData({abi:swapAbi,functionName:'swapExactTokensForTokens',args:[amount,minOut,route.hops,input.wallet,deadline]})});
  tokens.push({token:row.token,symbol:row.symbol,amountRaw:amount.toString(),amountFormatted:row.amountFormatted,allowanceRaw:allowance.toString(),quotedOutput:row.outputFormatted,minimumOutput:formatUnits(minOut,6)});
 }
 if((await runtime.client.getBlock({blockNumber})).hash!==block.hash)throw Error('Block changed');
 if(Number(deadline)*1000<=Date.now())throw Error('Plan expired while preparing');
 const plan={chainId:8453,wallet:input.wallet,destination:'USDC',provider:'AERODROME',blockNumber:quote.blockNumber,blockHash:block.hash,expiresAt:new Date(Number(deadline)*1000).toISOString(),slippageBps:50,minimumOutput:formatUnits(minimum,6),tokens,calls,executable:false,simulation:{status:'NOT_SIMULATED',gas:null,reason:'Candidate ordered calls only. Atomic wallet batching, aggregate execution and token transfer behavior must be simulated before sending.'},executionMode:'REQUIRES_ATOMIC_WALLET_BATCH',warnings:['Minimum output excludes gas costs. Independent pool quotes can interact in a batch.','Existing sufficient allowances are left unchanged. New approvals are exact, with a zero reset when needed.','No signatures, wallet connection or broadcasting. Do not send these calls individually.']};
 return {...plan,planId:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}
