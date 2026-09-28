import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {WalletSession,rawAmount} from './wallet.js';

// Run the actual UI event handlers with a minimal DOM and controlled responses.
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.attributes={};this._text='';this.disabled=false;}
 set textContent(value){this._text=value;this.children=[];}
 get textContent(){return this._text+this.children.map(x=>x.textContent).join(' ');}
 append(...nodes){for(const node of nodes){node.remove?.();node.parent=this;this.children.push(node);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 setAttribute(key,value){this.attributes[key]=value;}
 querySelector(selector){return this.all().find(x=>selector.startsWith('.')?x.className===selector.slice(1):x.tag===selector)||null;}
 all(){return this.children.flatMap(x=>[x,...x.all()]);}
 dispatchEvent(e){this['on'+e.type]?.(e);}
}
const ids=new Map(['w','m','r','e','mc','saved-address-list','saved-address-status','save-address','wallet-provider','connect','disconnect','wallet-status','f'].map(id=>[id,new Element()]));
const walletA='0x0000000000000000000000000000000000000001',walletB='0x0000000000000000000000000000000000000002';
const token='0x0000000000000000000000000000000000000010';
const token2='0x0000000000000000000000000000000000000011';
const row=(address=token,value=null)=>({token:address,symbol:address===token?'AERO':'OTHER',status:'OBSERVED',amountRaw:'2000000',amountFormatted:'2',decimals:6,approximateUsd:value,blockNumber:'10',suspectedSpam:false,riskLevel:'UNVERIFIED'});
const page=(w,rows,status='INDEXER_CANDIDATES',offset=0,nextOffset=null)=>({wallet:w,rows,discoveryStatus:status,discoveryFailure:status==='UNAVAILABLE'?{code:'RATE_LIMITED'}:null,warnings:[],pagination:{offset,nextOffset,totalCandidates:nextOffset===null?offset+rows.length:3,inventoryId:'a'.repeat(64)}});
const queue=[],requests=[];
const context=vm.createContext({document:{querySelector:s=>ids.get(s.slice(1)),createElement:tag=>new Element(tag)},window:{},localStorage:{getItem:()=>null,setItem:()=>{}},WalletSession,rawAmount,discoverWallets:()=>{},validateUniversalPlan:()=>{},sampledSelectionChoice:()=>null,AbortController,Event,console,setTimeout:()=>1,clearTimeout:()=>{},fetch:async(url,init)=>{requests.push({url,body:JSON.parse(init.body),signal:init.signal});const response=queue.shift();assert.ok(response,'Unexpected fetch');return typeof response==='function'?response():{ok:true,json:async()=>response};}});
const source=readFileSync(new URL('./basket.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
vm.runInContext(source,context);
const result=ids.get('r'),error=ids.get('e');
const find=(tag,text)=>result.all().find(x=>x.tag===tag&&x.textContent===text);
const select=(name,address)=>{let x=result.all().find(x=>x.attributes['aria-label']===`Select ${name}`);assert.ok(x);assert.equal(x.disabled,true,'unverified contract starts locked');const review=result.all().find(x=>x.attributes['aria-label']===`I checked contract ${address}`);assert.ok(review);review.checked=true;review.onchange();x=result.all().find(x=>x.attributes['aria-label']===`Select ${name}`);assert.equal(x.disabled,false);x.checked=true;x.onchange();};
const amount=()=>result.all().find(x=>x.attributes['aria-label']==='Amount for AERO');
const submit=()=>ids.get('f').onsubmit({preventDefault(){}});
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
ids.get('w').value=walletA;queue.push(page(walletA,[row()], 'UNAVAILABLE'));submit();await settle();
assert.match(result.textContent,/rate limited/);select('AERO',token);amount().value='1';amount().oninput();
queue.push(page(walletA,[row(),row(token2,4)]));await find('button','Retry discovery').onclick();
assert.match(result.textContent,/1 token selected/);assert.equal(amount().value,'1');
find('button','Under $1 (1)').onclick();assert.match(result.textContent,/unknown value and remain visible/);assert.equal(result.all().filter(x=>x.attributes['aria-label']?.startsWith('Select ')).length,1);
// A new load must discard prior amounts, not silently reuse the edited value.
queue.push(page(walletA,[row()]));submit();await settle();select('AERO',token);assert.equal(amount().value,'2');
const quoted=amountRaw=>({wallet:walletA,destination:'USDC',provider:'AERODROME',rows:[{...row(),amountRaw,status:'INDICATIVE_QUOTE',outputFormatted:'1'}],totalOutputFormatted:'1',binding:{basketKey:'b'.repeat(64),executable:false,expired:false,expiresAt:new Date(Date.now()+30000).toISOString()}});
queue.push(quoted('1000000'));await find('button','Preview').onclick();assert.match(error.textContent,/Quote unavailable/);assert.equal(result.querySelector('.quote'),null);
queue.push(quoted('2000000'));await find('button','Preview').onclick();assert.match(result.querySelector('.quote').textContent,/1 USDC/);
// Pagination preserves the current selection and checks the next offset.
queue.push(page(walletA,[row()], 'INDEXER_CANDIDATES',0,1));submit();await settle();select('AERO',token);
queue.push(page(walletA,[row(token2,4)],'INDEXER_CANDIDATES',1,null));await find('button','Load more').onclick();assert.equal(requests.at(-1).body.offset,1);assert.match(result.textContent,/1 token selected/);
// Stale response from A cannot overwrite B after the address input changes.
let resolveA;queue.push(()=>new Promise(resolve=>{resolveA=resolve}));submit();
ids.get('w').value=walletB;ids.get('w').oninput();queue.push(page(walletB,[row(token2,0.5)]));submit();await settle();
resolveA({ok:true,json:async()=>page(walletA,[row()])});await settle();assert.doesNotMatch(result.textContent,/AERO/);assert.match(result.textContent,/OTHER/);
queue.push(()=>({ok:false,json:async()=>({error:{message:'Provider failed'}})}));submit();await settle();assert.equal(result.textContent,'No inventory loaded.');assert.equal(error.textContent,'Provider failed');
ids.get('w').value=walletA;queue.push(page(walletA,[{...row(),riskLevel:'KNOWN_CONTRACT'}]));submit();await settle();assert.equal(result.all().find(x=>x.attributes['aria-label']==='Select AERO').disabled,true,'only exact core addresses bypass review');
queue.push(page(walletA,[{...row(),riskLevel:'BLOCKED_METADATA',suspectedSpam:true,spamReason:'Imitates USDC'}]));submit();await settle();assert.equal(result.all().find(x=>x.attributes['aria-label']==='Select AERO').disabled,true);assert.match(result.textContent,/Blocked metadata/);assert.equal(result.all().some(x=>x.attributes['aria-label']===`I checked contract ${token}`),false);
assert.ok(requests.every(x=>['/api/basket/inventory','/api/basket/quote'].includes(x.url)));console.log('PASS UI flow: recovery with selection, unknown filters, fresh amounts, quote amount binding, pagination, stale wallet response and failed reload. No live wallet or network.');
