import {validateUniversalPlan} from './plan-guard.js';
import {WalletSession,discoverWallets,rawAmount} from './wallet.js';
(() => {
 const $=s=>document.querySelector(s), wallet=$('#w'), manual=$('#m'), result=$('#r'), error=$('#e');
 const WETH='0x4200000000000000000000000000000000000006',USDC='0x833589fcD6eDb6e08f4c7c32d4f71b54bdA02913'.toLowerCase();
 let amounts=new Map();
 let inventory=null, selected=new Set(), kept=new Set(), filter='all', destination='USDC', controller, sequence=0, expiry, busy=false;
 const address=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
 const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
 const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n};
 const manualTokens=()=>manual.value.split(/[\s,]+/).filter(Boolean);
 const storageKey=()=>`aero-basket-kept:${wallet.value.trim().toLowerCase()}:8453`;
 function readKept(){try{const a=JSON.parse(localStorage.getItem(storageKey())||'[]');kept=new Set(Array.isArray(a)?a.filter(address).map(x=>x.toLowerCase()):[])}catch{kept=new Set();error.textContent='Keep storage is unavailable. Changes will last only this session.'}}
 function saveKept(){try{localStorage.setItem(storageKey(),JSON.stringify([...kept]))}catch{error.textContent='Keep storage is unavailable. Changes will last only this session.'}}
 function short(value){if(typeof value!=='string'||!/^[-]?\d+(\.\d+)?$/.test(value))return 'Unknown';const sign=value.startsWith('-')?'-':'';const [a,b='']=value.replace(/^-/,'').split('.');const tail=b.slice(0,6).replace(/0+$/,'');if(a==='0'&&!tail&&/[1-9]/.test(b))return sign+'<0.000001';return sign+a+(tail?'.'+tail:'')}
 function eligible(row){try{return !row.suspectedSpam&&address(row.token)&&row.status==='OBSERVED'&&row.amountRaw!==null&&BigInt(row.amountRaw)>0n&&Number.isInteger(row.decimals)&&row.decimals>=0&&row.decimals<=36&&!kept.has(row.token.toLowerCase())}catch{return false}}
 function invalidate(){error.textContent='';controller?.abort();sequence++;clearTimeout(expiry);result.querySelector('.quote')?.remove();busy=false}
 function reset(){invalidate();inventory=null;selected.clear();amounts.clear();$('#mc').textContent=`${manualTokens().length} / 16`;result.textContent='Load a wallet to view available tokens.'}
 function showValue(row){return row.approximateUsd==null?'Value unknown':row.approximateUsd>0&&row.approximateUsd<0.01?'~<$0.01':`~$${row.approximateUsd.toLocaleString('en-US',{maximumFractionDigits:2})}`}
 function tokenRow(row){
  const node=el('article','','row'),check=el('input'),id=row.token.toLowerCase();check.type='checkbox';check.setAttribute('aria-label',`Select ${row.symbol||row.token}`);check.checked=selected.has(id);check.disabled=!eligible(row)||busy;
  check.onchange=()=>{invalidate();if(check.checked&&selected.size>=16){error.textContent='Select no more than 16 tokens.'}else{check.checked?selected.add(id):selected.delete(id);if(check.checked&&!amounts.has(id))amounts.set(id,id===WETH?'':row.amountFormatted)}render()};
  const info=el('div');info.append(el('div',row.symbol||row.token,'sym'),el('div',row.suspectedSpam?'Needs review':kept.has(id)?'Kept':row.status==='READ_FAILED'?'Balance unknown':row.status==='ZERO_BALANCE'?'No balance':showValue(row),'meta'));
  const amount=el('div',row.amountFormatted===null?'Unknown':short(row.amountFormatted),'bal');
  if(!row.suspectedSpam){const keep=el('button',kept.has(id)?'Unkeep':'Keep','keep');keep.disabled=busy;keep.setAttribute('aria-label',`${kept.has(id)?'Unkeep':'Keep'} ${row.symbol||row.token}`);keep.onclick=()=>{invalidate();kept.has(id)?kept.delete(id):kept.add(id);saveKept();selected.delete(id);render()};amount.append(keep)}
  const details=el('details');details.append(el('summary','Details'),el('p',row.token,'meta'),el('p',`Exact amount: ${row.amountFormatted??'UNKNOWN'}`,'meta'),el('p',`Value: ${showValue(row)}`,'meta'),el('p',`Checked at Base block ${row.blockNumber}`,'meta'));
  if(row.suspectedSpam)details.append(el('p',row.spamReason||'Metadata needs review. This is not a security verdict.','meta'));
  if(selected.has(id)){const label=el('label','Amount to exchange','amount-label'),input=el('input');input.type='text';input.inputMode='decimal';input.setAttribute('aria-label',`Amount for ${row.symbol||row.token}`);input.value=amounts.get(id)||'';input.placeholder=id===WETH?'Enter WETH amount':'0';input.disabled=busy;input.oninput=()=>{invalidate();amounts.set(id,input.value.trim());const total=result.querySelector('.collection-total');if(total)total.textContent='—'};label.append(input);details.append(el('p',id===WETH?'WETH needs an explicit amount. Your remaining WETH stays in your wallet.':'The amount above is the amount to exchange.','meta'));info.append(label)}
  node.append(check,info,amount,details);return node;
 }
 function render(){
  if(!inventory)return;result.replaceChildren();const p=inventory.pagination;
  const head=el('div','','head');head.append(el('b','Your tokens'),el('span',`${inventory.rows.length} checked / ${p.totalCandidates} candidates`,'meta'));result.append(head);
  const matches=(x,value)=>!x.suspectedSpam&&(value==='all'||x.status!=='ZERO_BALANCE'&&(x.approximateUsd==null||x.approximateUsd<(value==='u1'?1:5)));
  const filters=el('div','','filters');filters.setAttribute('aria-label','Filter loaded tokens');
  for(const [value,label] of [['all','All'],['u1','Under $1'],['u5','Under $5']]){
   const count=inventory.rows.filter(x=>matches(x,value)).length,b=el('button',`${label} (${count})`);
   b.setAttribute('aria-label',label);b.setAttribute('aria-pressed',String(filter===value));b.onclick=()=>{invalidate();filter=value;render()};filters.append(b);
  }result.append(filters);
  const normal=inventory.rows.filter(x=>matches(x,filter)),review=inventory.rows.filter(x=>x.suspectedSpam),unknown=normal.filter(x=>x.approximateUsd==null).length;
  const scope=filter==='all'?'All loaded tokens':filter==='u1'?'Under $1':'Under $5';
  const note=el('p',`${scope}: ${normal.length} shown of ${inventory.rows.length} loaded. ${unknown?`${unknown} have unknown value and remain visible. `:''}${filter!=='all'?'Zero balances excluded. ':''}${p.nextOffset!==null?'Load more to check the remaining candidates.':''}`,'meta');note.setAttribute('role','status');result.append(note);
  if(!normal.length)result.append(el('p','No loaded tokens match this filter. Try All or load more.','meta'));
  if(inventory.discoveryStatus==='UNAVAILABLE')result.append(el('p','Discovery unavailable. Only core tokens are shown. Reload to try again.','bad'));
  const list=el('div','','tokens');normal.forEach(x=>list.append(tokenRow(x)));result.append(list);
  if(review.length){const d=el('details','','review');d.append(el('summary',`Needs review (${review.length})`),el('p','Flagged by metadata only. These tokens cannot be selected here.','meta'));review.forEach(x=>d.append(tokenRow(x)));result.append(d)}
  result.append(el('p','Quotes via Aerodrome · classic pools only','meta'));const controls=el('div','','controls'),out=el('select');out.setAttribute('aria-label','Output asset');for(const name of ['USDC','ETH']){const o=el('option',name);o.value=name;out.append(o)}out.value=destination;out.onchange=()=>{invalidate();destination=out.value;render()};
  const preview=el('button',busy?'Checking…':'Preview','preview');preview.disabled=busy||!selected.size;preview.onclick=quote;controls.append(el('span',`${selected.size} selected`,'meta'),out,preview);result.append(controls);
  if(p.nextOffset!==null){const more=el('button',busy?'Loading…':'Load more','more');more.disabled=busy;more.onclick=()=>load(true);result.append(more)}
  const details=el('details');details.append(el('summary','Coverage and estimates'));(inventory.warnings||[]).forEach(x=>details.append(el('p',x,'meta')));result.append(details);
  const inventoryMain=el('div','','inventory-main'),panel=el('aside','','collection');panel.setAttribute('aria-label','Your collection');
  [...result.children].forEach(child=>inventoryMain.append(child));
  const chosen=inventory.rows.filter(x=>selected.has(x.token.toLowerCase())).map(x=>{try{const amount=rawAmount(amounts.get(x.token.toLowerCase())||'',x.decimals);return {...x,approximateUsd:x.approximateUsd===null?null:x.approximateUsd*Number(amount)/Number(x.amountRaw)}}catch{return {...x,approximateUsd:null}}}),known=chosen.filter(x=>x.approximateUsd!==null),sum=known.reduce((a,x)=>a+x.approximateUsd,0);
  panel.append(el('p','YOUR COLLECTION','eyebrow'),el('div',`${selected.size} token${selected.size===1?'':'s'} selected`,'meta'),el('p',known.length<chosen.length?'Known selected value':'Estimated selected value','meta'),el('div',selected.size?(known.length?(sum>0&&sum<.01?'~<$0.01':'~$'+sum.toLocaleString('en-US',{maximumFractionDigits:2})):'Unknown'):'$0.00','collection-total'));
  if(known.length<chosen.length)panel.append(el('p',`${chosen.length-known.length} selected token(s) have unknown value.`,'meta'));
  panel.append(el('p','Route · Aerodrome','route-label'),el('p','Classic pools only · before gas','meta'),controls,el('p','Review only. No approvals or swaps are sent.','meta'));
  const canCheck=destination==='USDC'&&selected.size>=2&&selected.size<=5&&!selected.has(USDC);
  const simulate=el('button',busy?'Checking…':'Simulate sequence','prepare');simulate.disabled=busy||!canCheck;simulate.onclick=()=>plan(true);
  const prepare=el('button',busy?'Checking…':'Prepare plan','prepare');prepare.disabled=busy||!canCheck;prepare.onclick=()=>plan(false);
  const compare=el('button',busy?'Comparing…':'Compare what to include','prepare');compare.disabled=busy||!canCheck;compare.onclick=compareSelection;
  const advanced=el('details','','advanced-actions');advanced.append(el('summary','Advanced route checks'),prepare,simulate);
  panel.append(compare,advanced,el('p','Comparison tests the full set and each one-token omission.','meta'));
  if(destination==='USDC'&&selected.has(USDC))panel.append(el('p','USDC is already the output asset. Deselect it to compare or simulate.','meta'));
  result.append(inventoryMain,panel);
 }
 async function load(more=false){
  const ts=manualTokens(),w=wallet.value.trim();if(!address(w)||ts.length>16||ts.some(x=>!address(x))||new Set(ts.map(x=>x.toLowerCase())).size!==ts.length){error.textContent='Enter a valid wallet and up to 16 unique token addresses.';return}
  invalidate();const n=sequence;controller=new AbortController();busy=true;error.textContent='';
  if(!more){inventory=null;selected.clear();readKept();result.textContent='Loading balances…'}else render();
  const offset=more?inventory.pagination.nextOffset:0,oldId=more?inventory.pagination.inventoryId:null;
  try{
   const body={wallet:w,offset};if(ts.length)body.tokens=ts;if(oldId)body.inventoryId=oldId;
   const response=await fetch('/api/basket/inventory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}),data=await response.json();if(n!==sequence)return;
   if(!response.ok)throw Error(data.error?.message||'Inventory unavailable. Reload to try again.');const p=data.pagination;
   if(!same(data.wallet,w)||!Array.isArray(data.rows)||data.rows.length>16||!p||p.offset!==offset||!Number.isInteger(p.totalCandidates)||!(/^[a-f0-9]{64}$/).test(p.inventoryId)||more&&oldId!==p.inventoryId||p.nextOffset!==null&&p.nextOffset!==offset+data.rows.length||data.rows.some(x=>!address(x.token))||new Set(data.rows.map(x=>x.token.toLowerCase())).size!==data.rows.length)throw Error('Inventory mismatch. Reload from the first page.');
   const rows=new Map((more?inventory.rows:[]).map(x=>[x.token.toLowerCase(),x]));data.rows.forEach(x=>rows.set(x.token.toLowerCase(),x));inventory={...data,rows:[...rows.values()]};busy=false;render();
  }catch(e){if(n!==sequence)return;busy=false;if(e.name!=='AbortError')error.textContent=e.message;if(inventory)render();else result.textContent='No inventory loaded.'}
 }
 function selectedAmounts(){const out={};for(const token of selected){const row=inventory.rows.find(x=>same(x.token,token));const raw=rawAmount(amounts.get(token)||'',row.decimals);if(BigInt(raw)>BigInt(row.amountRaw))throw Error(`Amount exceeds ${row.symbol||'token'} balance.`);out[token]=raw}return out}
 async function quote(){
  let limits;try{limits=selectedAmounts()}catch(e){error.textContent=e.message;return}
  invalidate();const n=sequence,w=inventory.wallet,tokens=[...selected],output=destination;controller=new AbortController();busy=true;error.textContent='';render();
  try{
   const response=await fetch('/api/basket/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:w,tokens,amounts:limits,destination:output,provider:'AERODROME'}),signal:controller.signal}),data=await response.json();if(n!==sequence)return;const b=data.binding,expires=Date.parse(b?.expiresAt);
   if(!response.ok||!same(data.wallet,w)||data.destination!==output||data.provider!=='AERODROME'||!Array.isArray(data.rows)||data.rows.length!==tokens.length||new Set(data.rows.map(x=>x.token?.toLowerCase())).size!==tokens.length||!data.rows.every(x=>tokens.some(t=>same(t,x.token)))||!b||!(/^[a-f0-9]{64}$/).test(b.basketKey)||b.executable!==false||b.expired||!Number.isFinite(expires)||expires<=Date.now())throw Error('Quote unavailable. Request a fresh preview.');
   busy=false;render();const box=el('section','','quote'),paused=data.rows.some(x=>x.status==='PROVIDER_APPROVAL_REQUIRED');box.append(el('b',paused?'Route preview paused':data.totalOutputFormatted===null?'Quote unavailable':`${short(data.totalOutputFormatted)} ${output}`),el('p',paused?'Permission to share selected tokens and amounts with KyberSwap is pending. No route request was sent.':'Aerodrome classic pools · before gas. Limited route coverage; execution not simulated.','meta'));
   const routes=el('div','','quote-rows');
   for(const row of data.rows){const route=el('div','','quote-row');const status=row.status==='INDICATIVE_QUOTE'?`${short(row.outputFormatted)} ${output}`:row.status==='ALREADY_DESTINATION'?'Already in output asset':row.status==='QUOTE_UNAVAILABLE'?'Route unavailable':row.status==='NO_POSITIVE_QUOTE'?'No positive output':row.status==='ZERO_BALANCE'?'No balance':row.status==='PROVIDER_APPROVAL_REQUIRED'?'Permission required':'Could not verify';route.append(el('b',row.symbol||row.token),el('span',status));const detail=el('details');detail.append(el('summary','Route details'),el('p',row.token,'meta'),el('p',row.reason,'meta'));route.append(detail);routes.append(route)}box.append(routes);
   const d=el('details');d.append(el('summary','Execution details'),el('p',data.simulation?.reason||'Execution has not been simulated.','meta'));box.append(d);result.querySelector('.collection').append(box);expiry=setTimeout(()=>{box.replaceChildren(el('b','Preview expired'),el('p','Request a fresh preview.','meta'))},Math.min(expires-Date.now(),60000));
  }catch(e){if(n!==sequence)return;busy=false;if(e.name!=='AbortError')error.textContent=e.message;render()}
 }
 async function plan(simulate=false){
  let limits;try{limits=selectedAmounts()}catch(e){error.textContent=e.message;return}
  invalidate();const n=sequence,w=inventory.wallet,tokens=[...selected];controller=new AbortController();busy=true;error.textContent='';render();
  try{
   const response=await fetch(simulate?'/api/basket/simulate':'/api/basket/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:w,tokens,amounts:limits}),signal:controller.signal}),data=await response.json();if(n!==sequence)return;
   const expires=Date.parse(data.expiresAt);
   if(!response.ok||!same(data.wallet,w)||data.chainId!==8453||data.destination!=='USDC'||data.provider!=='AERODROME'||data.executable!==false||data.simulation?.status!=='NOT_SIMULATED'||!Array.isArray(data.tokens)||data.tokens.length!==tokens.length||new Set(data.tokens.map(x=>x.token?.toLowerCase())).size!==tokens.length||!data.tokens.every(x=>tokens.some(t=>same(t,x.token))&&x.amountRaw===limits[x.token.toLowerCase()])||!Array.isArray(data.calls)||!Number.isFinite(expires)||expires<=Date.now())throw Error('Plan unavailable. Every input needs a fresh positive route to USDC.');
   validateUniversalPlan(data,{wallet:w,tokens,amounts:limits});
   busy=false;render();const box=el('section','','quote');box.append(el('b',simulate?'Sequence simulated · sending disabled':'Unsigned plan · not simulated'),el('p',`Minimum: ${short(data.minimumOutput)} USDC before gas`),el('p',`1 basket swap · ${data.calls.filter(x=>x.kind!=='UNIVERSAL_SWAP').length} permission calls · 0.5% slippage`,'meta'),el('p','Permissions come first, then one basket swap. Sending is disabled during verification.','meta'));
   for(const token of data.tokens)box.append(el('p',`${token.amountFormatted} ${token.symbol||token.token} → USDC`));
   box.append(el('p',`Recipient: ${data.wallet}`,'meta'));
   if(simulate){const sim=data.sequenceSimulation;if(sim?.status!=='SEQUENCE_SIMULATED'||sim.planId!==data.planId||sim.executable!==false)throw Error('Simulation could not be verified.');box.append(el('p',`Simulated output: ${sim.receivedUsdc} USDC`),el('p',`Sequence gas: ${sim.gasUsedRaw} units across approvals and swap.`,'meta'));const value=data.valueDecision;if(value?.status==='ESTIMATED'&&value.grossUsdc===sim.receivedUsdc&&typeof value.estimatedNetUsdc==='string'&&typeof value.estimatedNetworkFeeUsdc==='string'){box.append(el('b',value.worthCollecting?'Worth collecting? Estimated yes':'Worth collecting? Estimated no'),el('p',`Estimated network cost: ${short(value.estimatedNetworkFeeUsdc)} USDC`),el('p',`Estimated after network cost: ${short(value.estimatedNetUsdc)} USDC`),el('p','This is a time-sensitive estimate, not a guaranteed payout. Real wallet execution and full affordability remain unverified.','meta'))}else box.append(el('b','Worth collecting? Unknown'),el('p',value?.reason||'A complete network fee estimate is unavailable.','meta'))}
   const detail=el('details');detail.append(el('summary','Inspect unsigned calls'),el('pre',JSON.stringify(data,null,2)));box.append(detail);result.querySelector('.collection').append(box);
   expiry=setTimeout(()=>box.replaceChildren(el('b','Plan expired'),el('p','Prepare a fresh plan.','meta')),Math.max(0,expires-Date.now()));
  }catch(e){if(n!==sequence)return;busy=false;if(e.name!=='AbortError')error.textContent=e.message;render()}
 }
 async function compareSelection(){
  let limits;try{limits=selectedAmounts()}catch(e){error.textContent=e.message;return}
  invalidate();const n=sequence,w=inventory.wallet,tokens=[...selected];controller=new AbortController();busy=true;error.textContent='';render();
  try{
   const response=await fetch('/api/basket/compare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:w,tokens,amounts:limits}),signal:controller.signal}),data=await response.json();if(n!==sequence)return;
   const expected=[tokens,...tokens.map((_,i)=>tokens.filter((__,j)=>j!==i))];
   if(!response.ok||!same(data.wallet,w)||data.chainId!==8453||data.destination!=='USDC'||data.provider!=='AERODROME'||data.executable!==false||!/^0x[0-9a-f]{64}$/i.test(data.anchorBlockHash)||!Array.isArray(data.candidates)||data.candidates.length!==expected.length||!['COMPLETE_SAMPLED','PARTIAL_SAMPLED','INCOMPARABLE'].includes(data.status))throw Error('Comparison unavailable. Request a fresh check.');
   for(let i=0;i<expected.length;i++){
    const row=data.candidates[i];if(!Array.isArray(row.tokens)||row.tokens.length!==expected[i].length||!row.tokens.every((x,j)=>same(x,expected[i][j]))||!['ESTIMATED','UNKNOWN','UNVERIFIED'].includes(row.status))throw Error('Comparison identity mismatch.');
    if(row.status==='ESTIMATED'&&(typeof row.netUsdc!=='string'||!/^[-]?\d+(\.\d{1,6})?$/.test(row.netUsdc)||!Number.isFinite(Date.parse(row.expiresAt))))throw Error('Comparison value unavailable.');
   }
   busy=false;render();const box=el('section','','quote');box.append(el('b','What is worth including?'),el('p',`Read-only snapshot · Base block ${data.anchorBlockNumber}`,'meta'));
   box.append(el('p',data.status==='COMPLETE_SAMPLED'?'All sampled options verified at the same block.':data.status==='PARTIAL_SAMPLED'?'Some options could not be verified. The order below covers verified options only.':'Results cannot be compared reliably. Review each result and try again.','meta'));
   const rows=data.status==='INCOMPARABLE'?data.candidates:data.ranked.map(x=>({...data.candidates.find(row=>row.tokens.length===x.tokens.length&&row.tokens.every((t,i)=>same(t,x.tokens[i]))),deltaVsFullUsdc:x.deltaVsFullUsdc})).filter(x=>Array.isArray(x.tokens));
   for(const [index,row] of rows.entries()){const names=row.tokens.map(t=>inventory.rows.find(x=>same(x.token,t))?.symbol||`${t.slice(0,6)}…`).join(' + '),line=el('div','','quote-row');line.append(el('b',`${data.status==='INCOMPARABLE'?'':`${index+1}. `}${names}`),el('span',row.status==='ESTIMATED'?`${short(row.netUsdc)} USDC net est.`:row.status==='UNKNOWN'?'Network cost unknown':'Could not verify'));if(row.excluded.length){const omitted=row.excluded.map(t=>inventory.rows.find(x=>same(x.token,t))?.symbol||`${t.slice(0,6)}…`).join(', '),delta=row.deltaVsFullUsdc,impact=typeof delta==='string'&&/^[-]?\d+(\.\d{1,6})?$/.test(delta)&&delta!=='0'?(delta.startsWith('-')?`Omitting it lowered the same-block net estimate by ${short(delta.slice(1))} USDC.`:`Omitting it raised the same-block net estimate by ${short(delta)} USDC.`):'This tests whether including it improves the after-fee result.';line.append(el('p',`Omitted: ${omitted}. ${impact}`,'meta'))}box.append(line)}
   if(data.status==='PARTIAL_SAMPLED'){for(const row of data.candidates.filter(x=>x.status!=='ESTIMATED'))box.append(el('p',`${row.tokens.map(t=>inventory.rows.find(x=>same(x.token,t))?.symbol||`${t.slice(0,6)}…`).join(' + ')}: ${row.status==='UNKNOWN'?'Network cost unknown':'Could not verify'}. Not ranked.`,'meta'))}
   box.append(el('p','Only the full selection and each one-token omission were tested. Other subsets may do better. Estimates can expire or change; no wallet execution was verified. Sending is disabled.','meta'));
   result.querySelector('.collection').append(box);
   const times=data.candidates.filter(x=>x.status==='ESTIMATED').map(x=>Date.parse(x.expiresAt)).filter(Number.isFinite);if(times.length)expiry=setTimeout(()=>box.append(el('p','Snapshot expired. Compare again for fresh estimates.','bad')),Math.max(0,Math.min(...times)-Date.now()));
  }catch(e){if(n!==sequence)return;busy=false;if(e.name!=='AbortError')error.textContent=e.message;render()}
 }
 const providers=[],providerSelect=$('#wallet-provider'),connect=$('#connect'),disconnect=$('#disconnect'),walletStatus=$('#wallet-status');
 const session=new WalletSession(state=>{
  reset();disconnect.hidden=!session.provider;connect.disabled=state.status==='connecting'||providers.length===0;
  if(state.status==='connecting')walletStatus.textContent='Waiting for wallet connection…';
  else if(state.status==='connected'){
   wallet.value=state.account;
   const capability='No wallet upgrade required for the planned router flow. Sending is disabled.';
   walletStatus.textContent=`Connected on Base. ${capability}`;
   load(false);
  }else if(state.status==='wrong-chain')walletStatus.textContent='Switch to Base in your wallet, then reconnect. No network switch was requested.';
  else if(state.status==='changed')walletStatus.textContent='Wallet account or network changed. Reconnect to refresh balances and capabilities.';
  else if(state.status==='error')walletStatus.textContent=state.message;
  else walletStatus.textContent='Disconnected locally. Existing wallet permissions are unchanged.';
 });
 connect.disabled=true;
 discoverWallets(window,item=>{providers.push(item);const option=el('option',item.name);option.value=String(providers.length-1);providerSelect.append(option);connect.disabled=session.state.status==='connecting';if(session.state.status==='disconnected')walletStatus.textContent='Connect to check your account. No signing.'});
 if(!providers.length)walletStatus.textContent='No browser wallet detected. Open this app in a wallet-enabled browser. You can still load an address.';
 connect.onclick=()=>{const item=providers[Number(providerSelect.value)];if(item)session.connect(item.provider)};
 disconnect.onclick=()=>session.detach();
 providerSelect.onchange=()=>session.detach();
 wallet.oninput=()=>{if(session.state.status==='connected'&&!same(wallet.value.trim(),session.state.account))session.detach();else reset()};manual.oninput=reset;$('#f').onsubmit=e=>{e.preventDefault();load(false)};
})();
