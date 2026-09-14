import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createOverviewWebServer,validatePublicOrigin} from './web-server.js';
for(const origin of ['http://example.com','https://example.com/path','https://user:pass@example.com','https://example.com?q=x'])assert.throws(()=>validatePublicOrigin(origin));
const server=createOverviewWebServer({publicOrigin:'https://collect-test.onrender.com'});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as any).port;
async function get(path:string,host='collect-test.onrender.com',origin?:string){return new Promise<{status:number,body:string,location?:string}>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,headers:{host,...(origin?{origin}:{})}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode!,body,location:res.headers.location}))});req.on('error',reject);req.end()})}
try{assert.equal((await get('/')).location,'/basket');assert.equal((await get('/basket')).status,200);assert.equal((await get('/healthz')).status,200);assert.equal((await get('/healthz','evil.example')).status,403);assert.equal((await get('/healthz',undefined,'https://evil.example')).status,403);assert.equal((await get('/config.json')).status,404);assert.equal((await get('/reviews/basket-simulation/plan.json')).status,404);assert.equal((await get('/base-account-sdk.js')).status,200);console.log('PASS deployed origin: HTTPS validation, exact host/origin, root redirect, health, assets, private-path rejection.')}finally{await new Promise<void>(r=>server.close(()=>r()))}
