import assert from 'node:assert/strict';
// Browser-only adapter is tested against deterministic EIP-1193 providers.
// @ts-ignore JavaScript module intentionally has no build dependency.
import {WalletSession,discoverWallets,rawAmount,atomicStatus} from '../web/wallet.js';
const account='0x0000000000000000000000000000000000000001';
const requests:string[]=[],listeners=new Map<string,()=>void>();let network='0x2105',accounts=[account],capability='supported';
const provider={on:(e:string,f:()=>void)=>listeners.set(e,f),removeListener:(e:string)=>listeners.delete(e),request:async({method}:any)=>{requests.push(method);if(method==='eth_chainId')return network;if(method==='wallet_getCapabilities')return {'0x2105':{atomic:{status:capability}}};return accounts}};
const session=new WalletSession(()=>{});
await session.connect(provider);assert.equal(session.state.status,'connected');assert.equal(session.state.atomic,'supported');
listeners.get('accountsChanged')!();assert.equal(session.state.status,'changed');
network='0x1';await session.connect(provider);assert.equal(session.state.status,'wrong-chain');network='0x2105';
capability='ready';await session.connect(provider);assert.equal(session.state.atomic,'ready');
assert.equal(atomicStatus({'0x2105':{atomicBatch:{supported:true}}}),'unknown');
accounts=[];await session.connect(provider);assert.equal(session.state.status,'error');
let resolve:any;const slow={...provider,request:()=>new Promise(r=>resolve=r)};const pending=session.connect(slow);session.detach();resolve([account]);await pending;assert.equal(session.state.status,'disconnected');
assert.ok(requests.every(m=>['eth_requestAccounts','eth_chainId','wallet_getCapabilities','eth_accounts'].includes(m)));
assert.equal(rawAmount('0.00001',18),'10000000000000');assert.equal(rawAmount('1.234567',6),'1234567');
for(const value of ['0','-1','1e2','1.0000001','NaN',''])assert.throws(()=>rawAmount(value,6));
console.log('PASS wallet: Base identity, capability parsing, account/network invalidation, upgrade not requested, rejection, late connection cancellation, no write methods, exact amounts.');

accounts=[account];capability='supported';
await session.connect({...provider,request:async(a:any)=>{if(a.method==='eth_requestAccounts')listeners.get('accountsChanged')?.();return provider.request(a)}});assert.equal(session.state.status,'connected');session.detach();
console.log('PASS initial wallet accountsChanged event is accepted only after final identity recheck.');

// A switch during the final identity read cannot restore a valid session.
accounts=[account];network='0x2105';
await session.connect({...provider,request:async(a:any)=>{if(a.method==='eth_accounts')listeners.get('chainChanged')?.();return provider.request(a)}});
assert.equal(session.state.status,'changed');session.detach();
await session.connect(provider);listeners.get('disconnect')!();assert.equal(session.state.status,'changed');session.detach();
await session.connect({...provider,request:async()=>{throw Object.assign(Error('denied'),{code:4001})}});
assert.equal(session.state.status,'error');assert.equal(session.state.message,'Connection declined.');session.detach();
console.log('PASS wallet adversarial checks: final-read network race, disconnect invalidation and user refusal.');

// A named EIP-6963 wallet is offered without connecting or signing. Unsupported
// optional capabilities must not prevent its Base account from connecting.
const browser=new EventTarget() as EventTarget&{ethereum?:unknown};
const discovered:{name:string;provider:any}[]=[];const rabbyRequests:string[]=[];
const rabby={request:async({method}:any)=>{
 rabbyRequests.push(method);
 if(method==='eth_requestAccounts'||method==='eth_accounts')return [account];
 if(method==='eth_chainId')return '0x2105';
 if(method==='wallet_getCapabilities')throw Error('Unsupported method');
 throw Error('Unexpected wallet method');
}};
browser.addEventListener('eip6963:requestProvider',()=>{
 const event=new Event('eip6963:announceProvider');
 Object.defineProperty(event,'detail',{value:{provider:rabby,info:{name:'Rabby Wallet'}}});
 browser.dispatchEvent(event);
});
const stopDiscovery=discoverWallets(browser,(entry:{name:string;provider:any})=>discovered.push(entry));
assert.deepEqual(discovered.map(entry=>entry.name),['Rabby Wallet']);
assert.deepEqual(rabbyRequests,[],'wallet discovery does not request an account');
await session.connect(discovered[0].provider);
assert.equal(session.state.status,'connected');assert.equal(session.state.atomic,'unknown');
assert.deepEqual(rabbyRequests,['eth_requestAccounts','eth_chainId','wallet_getCapabilities','eth_accounts','eth_chainId']);
session.detach();stopDiscovery();
console.log('PASS named EIP-6963 Rabby adapter: optional capability failure, no discovery prompt or signing. Physical extension UI remains unverified.');
