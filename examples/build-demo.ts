import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {connect,exampleInput,root} from './connect.js';
import {allocationsSchema} from '../src/mcp/allocations.js';
const rows=[]; const timings:number[]=[];
let tools:unknown;
for(const partial of [false,true]){
 const client=await connect(false,partial);
 try {
  tools=(await client.listTools()).tools;
  for(let weight=0;weight<=10000;weight+=1000){
   const input=exampleInput(weight), start=performance.now();
   const response=await client.callTool({name:'aerodrome_compare_allocations',arguments:input});
   timings.push(performance.now()-start);
   assert.notEqual(response.isError,true);
   const value=allocationsSchema.parse(response.structuredContent);
   assert.equal(value.status,partial?'PARTIAL_BOUNDED_SCOPE':'VERIFIED_BOUNDED_SCOPE');
   // Independent synthetic oracle: D=50, other=80, own=floor(40*w/10000).
   for(const scenario of [value.scenarios[0],...value.scenarios[0].sensitivity.map(s=>s.result)]){
    const stress=scenario===value.scenarios[0]?0:value.scenarios[0].sensitivity.find(s=>s.result===scenario)!.otherVoteIncreaseBps;
    scenario.pools.forEach((pool,i)=>{
     const own=40n*BigInt(input.scenarios[0].weightsBps[i])/10000n;
     const denominator=80n+80n*BigInt(stress)/10000n+own;
     assert.equal(pool.contracts[0].denominatorRaw,denominator.toString());
     assert.equal(pool.contracts[0].rewards[0].estimatedRewardRaw,(50n*own/denominator).toString());
    });
   }
   rows.push({partial,weight,input,result:value});
  }
 } finally {await client.close();}
}
const sorted=[...timings].sort((a,b)=>a-b);
const release=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
fs.writeFileSync(path.join(root,'integration-demo/data.json'),JSON.stringify({source:'SYNTHETIC_STDIO_FIXTURE',schemaVersion:1,generatedAt:new Date().toISOString(),rows},null,2));
fs.writeFileSync(path.join(root,'integration-demo/contracts.json'),JSON.stringify({release,transport:'stdio',tools},null,2));
fs.writeFileSync(path.join(root,'integration-demo/benchmark.json'),JSON.stringify({mode:'SYNTHETIC_STDIO',samples:timings.length,node:process.version,platform:process.platform,medianMs:Math.round(sorted[Math.floor(sorted.length/2)]),maxMs:Math.round(sorted.at(-1)!),scope:'Tool latency after connection; includes validation and serialization. No RPC. Not a production SLA.',arithmeticOracle:'22 inputs x 4 stress states x 2 pools = 176 checks of denominators and rewards passed'},null,2));
console.log('Generated 22 real stdio fixture results; 176 independent arithmetic checks passed.');
