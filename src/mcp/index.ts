import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAeroMcpServer } from "./server.js";

void serveStdio(() => createAeroMcpServer(), {
  transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65_536 })
});
console.error("Aerodrome read-only MCP v0.1 running on stdio");
