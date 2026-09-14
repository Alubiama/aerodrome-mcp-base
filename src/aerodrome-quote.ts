import {parseAbi,type Address} from 'viem';
export const CLASSIC_ROUTER='0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as Address;
const FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as Address;
export const QUOTE_WETH='0x4200000000000000000000000000000000000006' as Address;
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const abi=parseAbi(['function getAmountsOut(uint256 amountIn, (address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)']);
type Hop={from:Address;to:Address;stable:boolean;factory:Address};
export function classicPaths(from:Address,to:Address):Hop[][] {
 const hop=(a:Address,b:Address):Hop=>({from:a,to:b,stable:false,factory:FACTORY});
 const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
 if(same(from,to))return [];
 return [[hop(from,to)],...[USDC,QUOTE_WETH].filter(x=>!same(x,from)&&!same(x,to)).map(x=>[hop(from,x),hop(x,to)])];
}
export async function classicQuote(client:any,from:Address,to:Address,amount:bigint,blockNumber:bigint,signal:AbortSignal){
 const paths=classicPaths(from,to);const results=await Promise.allSettled(paths.map(routes=>client.readContract({address:CLASSIC_ROUTER,abi,functionName:'getAmountsOut',args:[amount,routes],blockNumber})));
 signal.throwIfAborted();let best: {amountOut:bigint;routes:Hop[]}|null=null;
 for(let i=0;i<results.length;i++){const r=results[i];if(r.status!=='fulfilled')continue;const a=r.value;if(!Array.isArray(a)||a.length!==paths[i].length+1||a[0]!==amount||a.some(x=>typeof x!=='bigint'||x<0n||x>(1n<<256n)-1n))continue;const out=a.at(-1)!;if(out>0n&&(!best||out>best.amountOut))best={amountOut:out,routes:paths[i]};}
 return best;
}
