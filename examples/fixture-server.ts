import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {createAeroMcpServer} from '../src/mcp/server.js';
import {getAllocationComparison} from '../src/mcp/allocations.js';
import {fixture} from '../src/allocation-fixture.js';
const mode=process.argv.includes('--partial')?'missing':'normal';
void serveStdio(()=>createAeroMcpServer({protocolStatus:async()=>({}),votingPosition:async()=>({}),walletRewards:async()=>({}),allocationComparison:i=>getAllocationComparison(i,fixture(mode).runtime)}),{transport:new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:65536})});
