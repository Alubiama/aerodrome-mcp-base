import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAeroMcpServer } from "./mcp/server.js";
import { getDecisionCard, validateDecisionCard } from "./mcp/decision-card.js";
import { fixture } from "./allocation-fixture.js";
const address=(n:number)=>`0x${n.toString(16).padStart(40,"0")}`;
const server=createAeroMcpServer({protocolStatus:async()=>({}),votingPosition:async()=>({}),walletRewards:async()=>({}),decisionCard:i=>getDecisionCard(i,fixture().runtime)});
const client=new Client({name:"synthetic-allocation-demo",version:"1"});
const [ct,st]=InMemoryTransport.createLinkedPair();
try {
 await Promise.all([server.connect(st),client.connect(ct)]);
 const response=await client.callTool({name:"aerodrome_decision_card",arguments:{allocation:{pools:[address(10),address(12)],tokenIds:["1"],scenarios:[{name:"Equal",weightsBps:[5000,5000]},{name:"First pool",weightsBps:[10000,0]}]}}});
 if(response.isError) throw new Error("Demo failed");
 const card=validateDecisionCard(response.structuredContent);
 console.error("SYNTHETIC DEMO: no real wallet, RPC, forecast or executed vote. JSON stdout can be saved with save-card.");
 console.log(JSON.stringify(card,null,2));
} finally {await client.close();await server.close();}
