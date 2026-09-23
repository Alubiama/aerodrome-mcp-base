import assert from 'node:assert/strict';
import {simulationRequest,analyzeBasketSimulation} from './basket-simulation.js';
const plan:any={wallet:'0x0000000000000000000000000000000000000001',chainId:8453,executable:false,expiresAt:new Date(Date.now()+60000).toISOString(),planId:'test',minimumOutput:'2',tokens:[2,3].map(n=>({token:'0x'+String(n).padStart(40,'0'),amountRaw:'100',allowanceRaw:'0'})),calls:[{to:'0x0000000000000000000000000000000000000002',value:'0x0',data:'0x'}]};
const bal=(n:bigint)=>({status:'0x1',returnData:'0x'+n.toString(16).padStart(64,'0')});
const ok=()=>[{calls:[bal(1000000n),bal(1000n),bal(0n),bal(1000n),bal(0n),{status:'0x1',gasUsed:'0x5208'},bal(3100000n),bal(900n),bal(0n),bal(900n),bal(0n)]}];
const req:any=simulationRequest(plan);assert.equal(req.method,'eth_simulateV1');assert.equal(req.params[0].blockStateCalls[0].calls.length,11);assert.equal(req.params[0].validation,false);assert.equal(req.params[0].blockStateCalls[0].stateOverrides,undefined);
const got=analyzeBasketSimulation(plan,ok());assert.equal(got.receivedUsdc,'2.1');assert.equal(got.gasUsedRaw,'21000');assert.equal(got.executable,false);assert.equal(got.inputEffects.length,2);
assert.throws(()=>analyzeBasketSimulation(plan,[]),/count/);
for(let i=0;i<11;i++){const bad:any=ok();bad[0].calls[i].status='0x0';assert.throws(()=>analyzeBasketSimulation(plan,bad),/failed/);}
for(const n of [899n,901n]){const bad:any=ok();bad[0].calls[7]=bal(n);assert.throws(()=>analyzeBasketSimulation(plan,bad),/debit/);}
let bad:any=ok();bad[0].calls[8]=bal(1n);assert.throws(()=>analyzeBasketSimulation(plan,bad),/remaining allowance/);
bad=ok();bad[0].calls[2]=bal(1n);assert.throws(()=>analyzeBasketSimulation(plan,bad),/Allowance changed/);
bad=ok();bad[0].calls[6]=bal(2999999n);assert.throws(()=>analyzeBasketSimulation(plan,bad),/below/);
for(const i of [0,1,2,6,7,8]){const bad:any=ok();bad[0].calls[i].returnData='0x1';assert.throws(()=>analyzeBasketSimulation(plan,bad),/Malformed/);}
for(const patch of [{chainId:1},{executable:true},{expiresAt:'invalid'},{expiresAt:'2000-01-01'}])assert.throws(()=>analyzeBasketSimulation({...plan,...patch},ok()));
for(const value of [null,'0x','-1','0x'+'f'.repeat(65)]){const bad:any=ok();bad[0].calls[5].gasUsed=value;assert.throws(()=>analyzeBasketSimulation(plan,bad));}
for(const allowance of [1n,200n,(1n<<256n)-1n]){
 const p=structuredClone(plan);p.tokens[0].allowanceRaw=allowance.toString();const result:any=ok();result[0].calls[2]=bal(allowance);result[0].calls[8]=bal(allowance<100n?0n:allowance===((1n<<256n)-1n)?allowance:allowance-100n);assert.equal(analyzeBasketSimulation(p,result).status,'SEQUENCE_SIMULATED');
}
console.log('PASS simulation effects: exact debits, new/reset/existing/max allowances, drift, net output, all 11 failure positions, malformed probes, expiry/chain/gas. No atomic execution claim.');
