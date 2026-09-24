import {RequestAdmission} from './request-admission.js';
import {prepareAndSimulateBasket} from './basket-simulation.js';
import {compareBasketCandidates,compareInput} from './basket-compare.js';
import {planInput} from './basket-plan.js';
import {prepareUniversalBasketPlan} from './universal-plan.js';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { publicConfig } from "./config.js";
import { makeClient } from "./client.js";
import { getWalletOverview, walletOverviewInputSchema, walletOverviewSchema, type WalletOverviewInput } from "./mcp/overview.js";
import { overviewFixture } from "./overview-fixture.js";
import { readBasketInventory, quoteBasket, inventoryInput, basketQuoteInput, InventoryChangedError } from './basket.js';

export function validatePublicOrigin(value:string){
 const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Use a public HTTPS origin without credentials, path or query.');return url.origin;
}

type OverviewReader = (input: WalletOverviewInput, signal: AbortSignal) => Promise<unknown>;
export function createOverviewWebServer(options: { read?: OverviewReader; deadlineMs?: number; publicOrigin?: string; releaseCommit?: string } = {}) {
  const publicOrigin=options.publicOrigin?validatePublicOrigin(options.publicOrigin):undefined;
  const commit=options.releaseCommit??process.env.RENDER_GIT_COMMIT??'';
  const releaseCommit=/^[0-9a-f]{40}$/i.test(commit)?commit.toLowerCase():null;
  const admission=new RequestAdmission();
  const read: OverviewReader = options.read ?? ((input, signal) => {
    // Public defaults only: never inherit a local wallet, gauges or history.
    const cfg = publicConfig();
    return getWalletOverview(input, { cfg, signal, client: makeClient(cfg, { batchRpc: true, timeoutMs: 10_000, signal }) });
  });
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) error(res, 500, "INTERNAL", "Could not prepare the response. Please try again.");
    else res.end();
  }); });
  function error(res: ServerResponse, status: number, code: string, message: string) {
    json(res, status, { error: { code, message } });
  }
  function json(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const port = (server.address() as { port?: number } | null)?.port;
    const allowedHosts = publicOrigin?[new URL(publicOrigin).host]:[`127.0.0.1:${port}`, `localhost:${port}`];
    const host = req.headers.host ?? "";
    if (!allowedHosts.includes(host) || (req.headers.origin !== undefined && req.headers.origin !== (publicOrigin??`http://${host}`)) || req.headers["sec-fetch-site"] === "cross-site") {
      error(res, 403, "LOCAL_ONLY", "Open the app using its configured address."); return;
    }
    const url = new URL(req.url ?? "/", publicOrigin??`http://${host}`);
    if((req.method==='GET'||req.method==='HEAD')&&url.pathname==='/healthz'){json(res,200,{status:'ok',sendingEnabled:false,releaseCommit});return;}
    if(publicOrigin&&url.pathname==='/'){res.writeHead(302,{Location:'/basket'});res.end();return;}
    if (req.method === 'POST' && ['/api/basket/inventory','/api/basket/quote','/api/basket/plan','/api/basket/simulate','/api/basket/compare'].includes(url.pathname)) {
      if(req.headers['content-type']?.split(';')[0].trim()!=='application/json') {error(res,415,'JSON_REQUIRED','Send JSON.');return;}
      let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>4096){error(res,413,'TOO_LARGE','Request is too large.');return;}}
      let input:unknown;
      try {input=(url.pathname.endsWith('/inventory')?inventoryInput:url.pathname.endsWith('/compare')?compareInput:(url.pathname.endsWith('/plan')||url.pathname.endsWith('/simulate'))?planInput:basketQuoteInput).parse(JSON.parse(body));}
      catch {error(res,400,'INVALID_BASKET',url.pathname.endsWith('/compare')?'Select 2–5 valid input tokens and an address.':'Enter a valid wallet and up to 16 unique token addresses. Select USDC or ETH.');return;}
      const release=admission.acquire(req.socket.remoteAddress??'unknown');
      if(!release){res.setHeader('Retry-After','60');error(res,429,'BUSY','Request limit reached. Wait before trying again.');return;}
      const controller=new AbortController();let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.deadlineMs??(url.pathname.endsWith('/compare')?60000:30000));
      const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);
      try {
        const stopped=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Aborted')),{once:true}));
        const reader=url.pathname.endsWith('/inventory')?readBasketInventory:url.pathname.endsWith('/plan')?prepareUniversalBasketPlan:url.pathname.endsWith('/simulate')?prepareAndSimulateBasket:url.pathname.endsWith('/compare')?compareBasketCandidates:quoteBasket;
        const result=await Promise.race([reader(input,controller.signal),stopped]);json(res,200,result);
      } catch (e) {if(e instanceof InventoryChangedError){error(res,409,'INVENTORY_CHANGED','The token list changed. Reload from the first page.');return;}error(res,timedOut?504:502,'BASKET_UNAVAILABLE',timedOut?'The basket check timed out. Try fewer tokens.':'The basket could not be verified. No balance or quote should be assumed.');}
      finally {clearTimeout(timer);res.off('close',disconnect);release();}
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/demo") {
      const fixture = overviewFixture();
      const report = await getWalletOverview({ wallet: fixture.wallet, gauges: [fixture.gauge] }, fixture.runtime);
      json(res, 200, { source: "SYNTHETIC", report }); return;
    }
    if (req.method === "POST" && url.pathname === "/api/overview") {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        error(res, 415, "JSON_REQUIRED", "Send the wallet address as JSON."); return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1024) { error(res, 413, "TOO_LARGE", "Request is too large."); return; }
      }
      let input: WalletOverviewInput;
      try {
        const raw = JSON.parse(body);
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "wallet") || typeof raw.wallet !== "string") throw new Error();
        input = walletOverviewInputSchema.parse({ wallet: raw.wallet.trim() });
      } catch { error(res, 400, "INVALID_WALLET", "Enter a valid nonzero address: 0x followed by 40 hexadecimal characters."); return; }
      const release=admission.acquire(req.socket.remoteAddress??"unknown");
      if(!release){res.setHeader("Retry-After","60");error(res,429,"BUSY","Request limit reached. Wait before trying again.");return;}
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.deadlineMs ?? 30_000);
      const disconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", disconnect);
      try {
        const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
        const report = walletOverviewSchema.parse(await Promise.race([read(input, controller.signal), stopped]));
        if (report.wallet.toLowerCase() !== input.wallet!.toLowerCase()) throw new Error("Wallet mismatch");
        json(res, 200, { source: "LIVE_RPC", report });
      } catch {
        error(res, timedOut ? 504 : 502, timedOut ? "DEADLINE" : "READ_FAILED", timedOut ? "The Base RPC deadline was reached. Please try again later." : "Could not obtain consistent Base data. This does not mean a zero balance. Please try again later.");
      } finally { clearTimeout(timer); res.off("close", disconnect); release(); }
      return;
    }
    const files: Record<string, [string, string]> = {
      "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/styles.css": ["styles.css", "text/css"],
      '/basket':['basket.html','text/html'],'/collect.svg':['collect.svg','image/svg+xml'],'/wallet.js':['wallet.js','text/javascript'],'/plan-guard.js':['plan-guard.js','text/javascript'],'/comparison-choice.js':['comparison-choice.js','text/javascript'],'/basket.js':['basket.js','text/javascript'],'/basket.css':['basket.css','text/css']
    };
    if ((req.method === "GET" || req.method === "HEAD") && Object.hasOwn(files, url.pathname)) {
      const [filename, mime] = files[url.pathname];
      const content = await readFile(new URL(`../web/${filename}`, import.meta.url));
      res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` }); res.end(req.method === "HEAD" ? undefined : content); return;
    }
    error(res, 404, "NOT_FOUND", "Page not found.");
  }
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicOrigin=process.env.COLLECT_PUBLIC_ORIGIN??process.env.RENDER_EXTERNAL_URL;
  if(process.env.NODE_ENV==='production'&&!publicOrigin)throw Error('Production requires a public HTTPS origin.');
  const port = Number(process.env.PORT ?? process.env.AERODROME_WEB_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local port.");
  const server = createOverviewWebServer({publicOrigin});
  server.listen(port, publicOrigin?"0.0.0.0":"127.0.0.1", () => console.log(`Collect: ${publicOrigin??`http://127.0.0.1:${port}`}`));
  server.on("error", error => { console.error(error.message); process.exitCode = 1; });
}
