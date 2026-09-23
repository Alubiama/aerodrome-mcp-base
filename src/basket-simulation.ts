import {encodeFunctionData,parseAbi,parseUnits,formatUnits} from 'viem';
import {prepareBasketPlan} from './basket-plan.js';
import {prepareUniversalBasketPlan,UNIVERSAL_ROUTER} from './universal-plan.js';
import {CLASSIC_ROUTER} from './aerodrome-quote.js';
import {boundedJson} from './basket.js';
import {estimateBasketValue} from './basket-value.js';
type Plan=Awaited<ReturnType<typeof prepareBasketPlan>>;
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const abi=parseAbi(['function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)']);
function probes(plan:Plan){
 if(!Array.isArray(plan.tokens)||plan.tokens.length<1||plan.tokens.length>5||new Set(plan.tokens.map(t=>t.token.toLowerCase())).size!==plan.tokens.length||plan.tokens.some(t=>t.token.toLowerCase()===USDC.toLowerCase()))throw Error('Invalid input tokens');
 return [{from:plan.wallet,to:USDC,value:'0x0',data:encodeFunctionData({abi,functionName:'balanceOf',args:[plan.wallet]})},...plan.tokens.flatMap(t=>[{from:plan.wallet,to:t.token,value:'0x0',data:encodeFunctionData({abi,functionName:'balanceOf',args:[plan.wallet]})},{from:plan.wallet,to:t.token,value:'0x0',data:encodeFunctionData({abi,functionName:'allowance',args:[plan.wallet,(plan as any).executionMode==='APPROVALS_THEN_UNIVERSAL_SWAP'?UNIVERSAL_ROUTER:CLASSIC_ROUTER]})}])];
}
export function simulationRequest(plan:Plan){
 if(plan.chainId!==8453||plan.executable!==false||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=Date.now())throw Error('Invalid or expired plan');
 const checks=probes(plan);
 return {jsonrpc:'2.0',id:1,method:'eth_simulateV1',params:[{blockStateCalls:[{calls:[...checks,...plan.calls.map(c=>({from:plan.wallet,to:c.to,value:c.value,data:c.data})),...checks]}],validation:false,traceTransfers:false,returnFullTransactions:false},'pending']};
}
export function analyzeBasketSimulation(plan:Plan,result:any){
 simulationRequest(plan); // Recheck identity and expiry when the RPC result arrives.
 const probeCount=probes(plan).length;
 if(!Array.isArray(result)||result.length!==1||!Array.isArray(result[0]?.calls)||result[0].calls.length!==plan.calls.length+probeCount*2)throw Error('Simulation call count mismatch');
 const calls=result[0].calls;
 const quantity=(v:any)=>{if(typeof v!=='string'||!/^0x[0-9a-f]{1,64}$/i.test(v))throw Error('Malformed gas result');return BigInt(v)};
 const balance=(v:any)=>{if(typeof v!=='string'||!/^0x[0-9a-f]{64}$/i.test(v))throw Error('Malformed balance result');return BigInt(v)};
 let gas=0n;const callGasUsedRaw:string[]=[];
 calls.forEach((c:any,i:number)=>{if(c.status!=='0x1')throw Error(`Simulation call ${i+1} failed`);if(i>=probeCount&&i<probeCount+plan.calls.length){const used=quantity(c.gasUsed);gas+=used;callGasUsedRaw.push(used.toString())}});
 const after=probeCount+plan.calls.length;
 const delta=balance(calls[after].returnData)-balance(calls[0].returnData);
 const inputEffects=plan.tokens.map((token,i)=>{
 const offset=1+i*2,amount=BigInt(token.amountRaw),beforeBalance=balance(calls[offset].returnData),afterBalance=balance(calls[after+offset].returnData),beforeAllowance=balance(calls[offset+1].returnData),afterAllowance=balance(calls[after+offset+1].returnData);
 if(amount<=0n||beforeBalance-afterBalance!==amount)throw Error('Unexpected input debit');
 if(beforeAllowance!==BigInt(token.allowanceRaw))throw Error('Allowance changed since plan');
 const max=(1n<<256n)-1n;
 const expectedAllowance=beforeAllowance<amount?0n:beforeAllowance-amount;
 if(afterAllowance!==expectedAllowance&&!(beforeAllowance===max&&afterAllowance===max))throw Error('Unexpected remaining allowance');
 return {token:token.token,debitedRaw:amount.toString(),remainingAllowanceRaw:afterAllowance.toString()};
 });
 if(delta<parseUnits(plan.minimumOutput,6))throw Error('Simulated net USDC below minimum');
 if(Date.parse(plan.expiresAt)<=Date.now())throw Error('Simulation finished after plan expiry');
 return {status:'SEQUENCE_SIMULATED',planId:plan.planId,simulatedAt:new Date().toISOString(),expiresAt:plan.expiresAt,blockTag:'pending',receivedUsdc:formatUnits(delta,6),inputEffects,gasUsedRaw:gas.toString(),callGasUsedRaw,executable:false,atomicWalletBatch:'NOT_VERIFIED',totalFee:null,limitations:['Sequential calls with validation=false; nonce and gas affordability are not verified.','Gas units exclude balance probes and Base L1 data fees; full transaction fees are not verified.','Only selected ERC-20 balances and router allowances are checked; other assets, native balance and token honesty are not verified.','This is not actual wallet execution or a broadcast. Prior permission transactions are not rolled back by a failed swap.']};
}
export async function simulateBasketPlan(plan:Plan,signal:AbortSignal,fetcher:typeof fetch=fetch){
 const request=simulationRequest(plan);
 const response=await fetcher('https://mainnet-preconf.base.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),redirect:'error'});
 if(!response.ok)throw Error(`Base simulation HTTP ${response.status}`);
 const data:any=await boundedJson(response);if(data.error||!data.result)throw Error('Base simulation RPC unavailable');
 return analyzeBasketSimulation(plan,data.result);
}

export async function prepareAndSimulateBasket(raw:unknown,signal:AbortSignal){
 const plan=await prepareUniversalBasketPlan(raw,signal);
 const sequenceSimulation=await simulateBasketPlan(plan,signal);
 const valueDecision=await estimateBasketValue(plan,sequenceSimulation,signal);
 return {...plan,sequenceSimulation,valueDecision};
}
