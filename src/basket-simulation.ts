import {encodeFunctionData,parseAbi,parseUnits,formatUnits} from 'viem';
import {prepareBasketPlan} from './basket-plan.js';
import {boundedJson} from './basket.js';
type Plan=Awaited<ReturnType<typeof prepareBasketPlan>>;
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const abi=parseAbi(['function balanceOf(address) view returns (uint256)']);
export function simulationRequest(plan:Plan){
 if(plan.chainId!==8453||plan.executable!==false||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=Date.now())throw Error('Invalid or expired plan');
 const balance={from:plan.wallet,to:USDC,value:'0x0',data:encodeFunctionData({abi,functionName:'balanceOf',args:[plan.wallet]})};
 return {jsonrpc:'2.0',id:1,method:'eth_simulateV1',params:[{blockStateCalls:[{calls:[balance,...plan.calls.map(c=>({from:plan.wallet,to:c.to,value:c.value,data:c.data})),balance]}],validation:false,traceTransfers:false,returnFullTransactions:false},'pending']};
}
export function analyzeBasketSimulation(plan:Plan,result:any){
 if(!Array.isArray(result)||result.length!==1||!Array.isArray(result[0]?.calls)||result[0].calls.length!==plan.calls.length+2)throw Error('Simulation call count mismatch');
 const calls=result[0].calls;
 const quantity=(v:any)=>{if(typeof v!=='string'||!/^0x[0-9a-f]+$/i.test(v))throw Error('Malformed gas result');return BigInt(v)};
 const balance=(v:any)=>{if(typeof v!=='string'||!/^0x[0-9a-f]{64}$/i.test(v))throw Error('Malformed balance result');return BigInt(v)};
 let gas=0n;
 calls.forEach((c:any,i:number)=>{if(c.status!=='0x1')throw Error(`Simulation call ${i+1} failed`);if(i>0&&i<calls.length-1)gas+=quantity(c.gasUsed)});
 const delta=balance(calls.at(-1).returnData)-balance(calls[0].returnData);
 if(delta<parseUnits(plan.minimumOutput,6))throw Error('Simulated net USDC below minimum');
 if(Date.parse(plan.expiresAt)<=Date.now())throw Error('Simulation finished after plan expiry');
 return {status:'SEQUENCE_SIMULATED',planId:plan.planId,simulatedAt:new Date().toISOString(),expiresAt:plan.expiresAt,blockTag:'pending',receivedUsdc:formatUnits(delta,6),gasUsedRaw:gas.toString(),executable:false,atomicWalletBatch:'NOT_VERIFIED',totalFee:null,limitations:['Sequential calls with validation=false; nonce and gas affordability are not verified.','Gas units exclude balance probes, wallet batch overhead and Base L1 data fees.','This is not an atomic wallet execution simulation or a broadcast.']};
}
export async function simulateBasketPlan(plan:Plan,signal:AbortSignal,fetcher:typeof fetch=fetch){
 const request=simulationRequest(plan);
 const response=await fetcher('https://mainnet-preconf.base.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),redirect:'error'});
 if(!response.ok)throw Error(`Base simulation HTTP ${response.status}`);
 const data:any=await boundedJson(response);if(data.error||!data.result)throw Error('Base simulation RPC unavailable');
 return analyzeBasketSimulation(plan,data.result);
}

export async function prepareAndSimulateBasket(raw:unknown,signal:AbortSignal){
 const plan=await prepareBasketPlan(raw,signal);
 const sequenceSimulation=await simulateBasketPlan(plan,signal);
 return {...plan,sequenceSimulation};
}
