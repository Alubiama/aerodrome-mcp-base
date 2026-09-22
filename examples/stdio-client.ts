import {performance} from 'node:perf_hooks';
import {connect,exampleInput} from './connect.js';
import {allocationsSchema} from '../src/mcp/allocations.js';
const live=process.argv.includes('--live');
const started=performance.now();
const client=await connect(live);
const connected=performance.now();
try {
 const response=await client.callTool({name:live?'aerodrome_protocol_status':'aerodrome_compare_allocations',arguments:live?{}:exampleInput()},{timeout:130000});
 if(response.isError) throw new Error('MCP read failed; inspect bounded error code before retrying');
 const result=live?response.structuredContent:allocationsSchema.parse(response.structuredContent);
 console.log(JSON.stringify({mode:live?'LIVE_PUBLIC_PROTOCOL_ONLY':'SYNTHETIC_STDIO',startupMs:Math.round(connected-started),toolMs:Math.round(performance.now()-connected),result},null,2));
} finally {await client.close();}
