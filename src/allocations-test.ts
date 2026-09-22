import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDecisionCard, getDecisionCard, validateDecisionCard, decisionCardInputSchema } from "./mcp/decision-card.js";
import { saveDecisionCard } from "./decision-card-store.js";
import assert from "node:assert/strict";
import { publicConfig } from "./config.js";
import { getAllocationComparison, allocationsInputSchema, allocationsSchema } from "./mcp/allocations.js";
import { splitVotingPower, estimateShare } from "./mcp/allocation-math.js";
import { createAeroMcpServer } from "./mcp/server.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fixture } from "./allocation-fixture.js";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const POOL = address(10);
const input = {pools:[POOL,address(12)],tokenIds:["1"],scenarios:[{name:"half",weightsBps:[5000,5000]},{name:"all",weightsBps:[10000,0]}]};
const result = await getAllocationComparison(input, fixture().runtime);
allocationsSchema.parse(result);
assert.deepEqual(result.scenarios[0].sensitivity.map(s=>s.result.pools[0].contracts[0].denominatorRaw),["116","140","180"]);
assert.deepEqual(result.scenarios[0].sensitivity.map(s=>s.result.tokenSubtotals[0].estimatedRewardRaw),["16","14","10"]);
assert.deepEqual(result.scenarios[0].sensitivity.map(s=>s.tokenChanges[0].decreaseBps),["2000","3000","5000"]);
assert.equal(result.scenarios[0].pools[0].allocatedVoteRaw,"20");
assert.equal(result.scenarios[0].pools[0].contracts[0].denominatorRaw,"100");
assert.equal(result.scenarios[0].tokenSubtotals[0].estimatedRewardRaw,"20");
assert.equal(result.scenarios[1].tokenSubtotals[0].estimatedRewardRaw,"16");
assert.equal(result.scenarios[1].pools[1].contracts[0].rewards[0].estimatedRewardRaw,"0");
assert.deepEqual(splitVotingPower([1n,1n],[5000,5000]),[0n,0n]);
assert.equal(estimateShare(50n,100n,20n,40n),16n);
assert.throws(()=>splitVotingPower([40n],[5000,4000]));
assert.throws(()=>estimateShare(1n,1n,2n,1n));
assert.equal(allocationsInputSchema.safeParse({...input,scenarios:[{name:"bad",weightsBps:[10000]}]}).success,false);
for (const mode of ["powerFail","managed","missing","existingExceeds"]) {
 const partial = await getAllocationComparison(input,fixture(mode).runtime);
 assert.equal(partial.status,"PARTIAL_BOUNDED_SCOPE");
 assert.equal(partial.scenarios[0].complete,false);
 assert.ok(partial.scenarios[0].sensitivity.every(s=>!s.result.complete && s.tokenChanges.every(t=>!t.complete)));
}
const multi = await getAllocationComparison({...input,tokenIds:["1","2"]},fixture().runtime);
assert.equal(multi.scenarios[0].pools[0].allocatedVoteRaw,"40");
assert.equal(multi.scenarios[0].pools[0].contracts[0].denominatorRaw,"100");
assert.equal(multi.scenarios[0].tokenSubtotals[0].estimatedRewardRaw,"40");
assert.equal(multi.scenarios[0].sensitivity[2].result.pools[0].contracts[0].rewards[0].estimatedRewardRaw,"12"); // 2 * floor(50*20/160)
const noOthers = fixture();
const originalRead = noOthers.runtime.client.readContract;
noOthers.runtime.client.readContract = async call => call.functionName === "totalSupply" ? 20n : originalRead(call);
const alone = await getAllocationComparison(input,noOthers.runtime);
assert.ok(alone.scenarios[0].sensitivity.every(s=>s.tokenChanges.every(t=>t.decreaseRaw==="0")));
const empty = fixture();
const emptyRead = empty.runtime.client.readContract;
empty.runtime.client.readContract = async call => call.functionName === "tokenRewardsPerEpoch" ? 0n : emptyRead(call);
const zeroRewards = await getAllocationComparison(input,empty.runtime);
assert.ok(zeroRewards.scenarios[0].sensitivity.every(s=>s.tokenChanges.every(t=>t.decreaseBps===null)));

const unknown = await getAllocationComparison(input,fixture("unknownDecimals").runtime);
assert.equal(unknown.scenarios[0].pools[0].contracts[0].rewards[0].estimatedRewardFormatted,null);
for (const mode of ["wrongChain","reorg","abort"]) await assert.rejects(getAllocationComparison(input,fixture(mode).runtime));
const draft=buildDecisionCard({allocation:input},result);
assert.equal(draft.decisionStatus,"DRAFT");
assert.equal(buildDecisionCard({allocation:input},result).cardId,draft.cardId);
const chosen=buildDecisionCard({allocation:input,selectedScenario:"half",reason:"Synthetic test choice"},result);
assert.equal(chosen.decisionStatus,"USER_SELECTED");
assert.notEqual(chosen.cardId,draft.cardId);
assert.equal(decisionCardInputSchema.safeParse({allocation:input,selectedScenario:"unknown",reason:"test"}).success,false);
assert.equal(decisionCardInputSchema.safeParse({allocation:input,selectedScenario:"half"}).success,false);
assert.throws(()=>validateDecisionCard({...draft,decisionStatus:"USER_SELECTED"}));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"aero-card-test-"));
try {
 const saved=saveDecisionCard(draft,path.join(dir,"cards"));
 assert.deepEqual(validateDecisionCard(JSON.parse(fs.readFileSync(saved,"utf8"))),draft);
 assert.equal(fs.statSync(saved).mode & 0o777,0o600);
 assert.throws(()=>saveDecisionCard(draft,path.join(dir,"cards")));
 fs.symlinkSync(path.join(dir,"cards"),path.join(dir,"alias"));
 assert.throws(()=>saveDecisionCard(chosen,path.join(dir,"alias")));
} finally {fs.rmSync(dir,{recursive:true,force:true});}
const server = createAeroMcpServer({decisionCard:(i)=>getDecisionCard(i,fixture().runtime),protocolStatus:async()=>({}),votingPosition:async()=>({}),walletRewards:async()=>({}),allocationComparison:(i)=>getAllocationComparison(i,fixture().runtime)});
const client = new Client({name:"allocations-test",version:"1"});
const [ct,st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st),client.connect(ct)]);
try {
 assert.ok((await client.listTools()).tools.some(t=>t.name==="aerodrome_compare_allocations"));
 const reply = await client.callTool({name:"aerodrome_compare_allocations",arguments:input});
 assert.notEqual(reply.isError,true);
 assert.deepEqual(allocationsSchema.parse(reply.structuredContent).scenarios,result.scenarios);
 const cardReply=await client.callTool({name:"aerodrome_decision_card",arguments:{allocation:input}});
 assert.notEqual(cardReply.isError,true);
 assert.equal(validateDecisionCard(cardReply.structuredContent).decisionStatus,"DRAFT");
 const invalid = await client.callTool({name:"aerodrome_compare_allocations",arguments:{...input,scenarios:[{name:"bad",weightsBps:[1,1]}]}});
 assert.equal(invalid.isError,true);
} finally { await client.close(); await server.close(); }
console.log("Allocation comparison tests passed: arithmetic, partial evidence, pinned reads, MCP call.");
