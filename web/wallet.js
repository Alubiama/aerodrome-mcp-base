const address=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
const chain=x=>typeof x==='string'&&/^0x[0-9a-f]+$/i.test(x)?BigInt(x):null;
export function atomicStatus(caps){const status=caps?.['0x2105']?.atomic?.status;return ['supported','ready','unsupported'].includes(status)?status:'unknown'}
export function rawAmount(value,decimals){
 if(!Number.isInteger(decimals)||decimals<0||decimals>36||typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value))throw Error('Enter a positive token amount.');
 const [a,b='']=value.split('.');if(b.length>decimals)throw Error('Too many decimal places.');
 const n=BigInt(a+b.padEnd(decimals,'0'));if(n<=0n||n>=(1n<<256n))throw Error('Enter a positive token amount.');return n.toString();
}
export class WalletSession{
 constructor(onChange){this.onChange=onChange;this.epoch=0;this.state={status:'disconnected'};this.provider=null;this.revision=0;this.listener=()=>{this.revision++;if(this.state.status!=='connecting')this.invalidate('changed')}}
 invalidate(status='disconnected'){this.epoch++;this.state={status};this.onChange(this.state)}
 detach(){this.provider?.removeListener?.('accountsChanged',this.listener);this.provider?.removeListener?.('chainChanged',this.listener);this.provider?.removeListener?.('disconnect',this.listener);this.provider=null;this.invalidate()}
 async request(method,params){let timer;try{return await Promise.race([this.provider.request({method,...(params?{params}:{})}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Wallet request timed out.')),30000)})])}finally{clearTimeout(timer)}}
 async connect(provider){
  this.detach();this.provider=provider;for(const event of ['accountsChanged','chainChanged','disconnect'])provider.on?.(event,this.listener);
  const epoch=this.epoch;this.state={status:'connecting'};this.onChange(this.state);
  try{
   const accounts=await this.request('eth_requestAccounts');if(epoch!==this.epoch)return;
   if(!Array.isArray(accounts)||!address(accounts[0]))throw Error('No wallet account available.');
   const currentChain=await this.request('eth_chainId');if(epoch!==this.epoch)return;
   if(chain(currentChain)!==8453n){this.state={status:'wrong-chain',account:accounts[0]};this.onChange(this.state);return}
   let caps;try{caps=await this.request('wallet_getCapabilities',[accounts[0],['0x2105']])}catch{caps=null}
   if(epoch!==this.epoch)return;
   const revision=this.revision;const fresh=await this.request('eth_accounts'),freshChain=await this.request('eth_chainId');if(epoch!==this.epoch)return;
   if(revision!==this.revision||!Array.isArray(fresh)||fresh[0]?.toLowerCase()!==accounts[0].toLowerCase()||chain(freshChain)!==8453n){this.invalidate('changed');return}
   this.state={status:'connected',account:accounts[0],chainId:'0x2105',atomic:atomicStatus(caps)};this.onChange(this.state);
  }catch(e){if(epoch!==this.epoch)return;this.state={status:'error',message:e?.code===4001?'Connection declined.':'Wallet connection unavailable. Allow the wallet popup, or open this page in a wallet-enabled browser and try again.'};this.onChange(this.state)}
 }
}
export function discoverWallets(win,onWallet){
 const seen=new Set();
 const add=(provider,name)=>{if(!provider||typeof provider.request!=='function'||seen.has(provider))return;seen.add(provider);onWallet({provider,name:typeof name==='string'?name.slice(0,80):'Browser wallet'})};
 const announce=e=>add(e.detail?.provider,e.detail?.info?.name);
 win.addEventListener('eip6963:announceProvider',announce);win.dispatchEvent(new Event('eip6963:requestProvider'));
 // Give named EIP-6963 providers time to announce before using the legacy
 // injected fallback, which may be the same Rabby provider object.
 const fallback=setTimeout(()=>{if(!seen.size)add(win.ethereum,'Browser wallet')},250);
 return ()=>{clearTimeout(fallback);win.removeEventListener('eip6963:announceProvider',announce)};
}
