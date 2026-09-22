import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function connect(live=false,partial=false){
 const client=new Client({name:'aero-integration-example',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,live?'src/mcp/index.ts':'examples/fixture-server.ts'),...(partial?['--partial']:[])],cwd:root,stderr:'pipe'});
 await client.connect(transport);
 return client;
}
export const exampleInput=(weight=5000)=>({pools:['0x000000000000000000000000000000000000000a','0x000000000000000000000000000000000000000c'],tokenIds:['1'],scenarios:[{name:'Example split',weightsBps:[weight,10000-weight]}]});
