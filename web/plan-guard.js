// Structural validation only: this does not authenticate prices, RPC data or wallet execution.
const ROUTER='0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const FACTORY='0x420dd381b31aef6683db6b902084cb0ffece40da';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH='0x4200000000000000000000000000000000000006';
const fail=()=>{throw Error('Unsigned plan validation failed. Request a fresh plan.');};
const check=value=>{if(!value)fail();};
const address=value=>{check(typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)&&!/^0x0{40}$/i.test(value));return value.toLowerCase();};
const uint=value=>{check(typeof value==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(value));const n=BigInt(value);check(n<(1n<<256n));return n;};
const units=value=>{check(typeof value==='string'&&/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,6})?$/.test(value));const [a,b='']=value.split('.');return uint((BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'))).toString());};
const word=n=>n.toString(16).padStart(64,'0');
const addrWord=a=>address(a).slice(2).padStart(64,'0');

export function validateUnsignedPlan(plan,expected,now=Date.now()){
 const wallet=address(expected.wallet),tokens=expected.tokens.map(address);
 check(tokens.length>=2&&tokens.length<=5&&new Set(tokens).size===tokens.length&&!tokens.includes(USDC));
 check(expected.amounts&&Object.keys(expected.amounts).length===tokens.length&&Object.keys(expected.amounts).every(t=>tokens.includes(t)));
 check(plan&&address(plan.wallet)===wallet&&plan.chainId===8453&&plan.destination==='USDC'&&plan.provider==='AERODROME');
 check(plan.executable===false&&plan.executionMode==='REQUIRES_ATOMIC_WALLET_BATCH'&&plan.simulation?.status==='NOT_SIMULATED'&&plan.slippageBps===50);
 const expires=Date.parse(plan.expiresAt);
 check(Number.isFinite(now)&&Number.isFinite(expires)&&expires>now&&expires<=now+60000&&expires%1000===0);
 check(Array.isArray(plan.tokens)&&plan.tokens.length===tokens.length&&new Set(plan.tokens.map(t=>address(t.token))).size===tokens.length);
 check(Array.isArray(plan.calls)&&plan.calls.length<=15);
 let index=0,total=0n;
 for(const token of plan.tokens){
  const input=address(token.token);check(tokens.includes(input));
  const amount=uint(token.amountRaw),allowance=uint(token.allowanceRaw),minimum=units(token.minimumOutput),quoted=units(token.quotedOutput);
  check(amount>0n&&token.amountRaw===expected.amounts[input]&&minimum>0n&&minimum===quoted*9950n/10000n);total+=minimum;
  const next=kind=>{const call=plan.calls[index++];check(call&&call.kind===kind&&address(call.token)===input&&call.value==='0x0'&&typeof call.data==='string');return call;};
  const approval=value=>{const call=next(value===0n?'RESET_APPROVAL':'EXACT_APPROVAL');check(address(call.to)===input&&address(call.spender)===ROUTER&&call.amountRaw===value.toString());check(call.data.toLowerCase()==='0x095ea7b3'+addrWord(ROUTER)+word(value));};
  if(allowance<amount){if(allowance>0n)approval(0n);approval(amount);}
  const call=next('SWAP');check(address(call.to)===ROUTER&&address(call.recipient)===wallet&&call.amountInRaw===amount.toString()&&call.minimumOutRaw===minimum.toString());
  const data=call.data.toLowerCase();check(/^0xcac88ea9[0-9a-f]+$/.test(data)&&[8+2+64*10,8+2+64*14].includes(data.length));
  const words=data.slice(10).match(/.{64}/g);const hops=Number(BigInt('0x'+words[5]));check(hops===1||hops===2);
  check(words.length===6+hops*4);
  let encoded='0xcac88ea9'+word(amount)+word(minimum)+word(160n)+addrWord(wallet)+word(BigInt(expires/1000))+word(BigInt(hops));
  const path=hops===1?[input,USDC]:[input,WETH,USDC];check(new Set(path).size===path.length);
  for(let h=0;h<hops;h++)encoded+=addrWord(path[h])+addrWord(path[h+1])+word(0n)+addrWord(FACTORY);
  check(data===encoded);
 }
 check(index===plan.calls.length&&total===units(plan.minimumOutput));
 return true;
}

const UNIVERSAL='0xcaf22ce31298cf2bf1d152862f80216478ad7c67';
const CODE_HASH='0xa11d1a13950f5b70dd0d7822e4e3b575778d8614e897c7810d7e6e9f310c017d';
const bytes=value=>word(BigInt(value.length/2))+value.padEnd(Math.ceil(value.length/64)*64,'0');
export function validateUniversalPlan(plan,expected,now=Date.now()){
 check(plan?.executionMode==='APPROVALS_THEN_UNIVERSAL_SWAP'&&address(plan.router)===UNIVERSAL&&plan.routerCodeHash===CODE_HASH);
 check(Array.isArray(plan.tokens)&&plan.tokens.length>=2&&plan.tokens.length<=5&&Array.isArray(plan.calls)&&plan.calls.length<=11);
 const wallet=address(expected.wallet),deadline=Date.parse(plan.expiresAt)/1000;
 check(Number.isSafeInteger(deadline));
 let cursor=0;const legacyCalls=[],inputs=[];
 for(const t of plan.tokens){
  const token=address(t.token),amount=uint(t.amountRaw),allowance=uint(t.allowanceRaw),minimum=units(t.minimumOutput);
  const approval=value=>{
   const c=plan.calls[cursor++];check(c&&address(c.spender)===UNIVERSAL&&typeof c.data==='string'&&c.data.toLowerCase()==='0x095ea7b3'+addrWord(UNIVERSAL)+word(value));
   legacyCalls.push({...c,spender:ROUTER,data:'0x095ea7b3'+addrWord(ROUTER)+word(value)});
  };
  if(allowance<amount){if(allowance>0n)approval(0n);approval(amount);}
  check(Array.isArray(t.routeTokens));const path=t.routeTokens.map(address);
  check((path.length===2||path.length===3)&&path[0]===token&&path.at(-1)===USDC&&new Set(path).size===path.length&&(path.length===2||path[1]===WETH));
  let classic='0xcac88ea9'+word(amount)+word(minimum)+word(160n)+addrWord(wallet)+word(BigInt(deadline))+word(BigInt(path.length-1));
  for(let i=0;i<path.length-1;i++)classic+=addrWord(path[i])+addrWord(path[i+1])+word(0n)+addrWord(FACTORY);
  legacyCalls.push({kind:'SWAP',token,to:ROUTER,value:'0x0',amountInRaw:t.amountRaw,minimumOutRaw:minimum.toString(),recipient:wallet,data:classic});
  const packed=path[0].slice(2)+path.slice(1).map(a=>'00'+a.slice(2)).join('');
  inputs.push(addrWord(wallet)+word(amount)+word(minimum)+word(192n)+word(1n)+word(0n)+bytes(packed));
 }
 const c=plan.calls[cursor++];check(c&&c.kind==='UNIVERSAL_SWAP'&&address(c.to)===UNIVERSAL&&address(c.recipient)===wallet&&c.value==='0x0'&&cursor===plan.calls.length&&typeof c.data==='string');
 const commands=bytes('08'.repeat(inputs.length));
 let offset=inputs.length*32;const tails=inputs.map(bytes);const offsets=tails.map(t=>{const w=word(BigInt(offset));offset+=t.length/2;return w;}).join('');
 const encoded='0x3593564c'+word(96n)+word(BigInt(96+commands.length/2))+word(BigInt(deadline))+commands+word(BigInt(inputs.length))+offsets+tails.join('');
 check(c.data.toLowerCase()===encoded);
 return validateUnsignedPlan({...plan,executionMode:'REQUIRES_ATOMIC_WALLET_BATCH',calls:legacyCalls},expected,now);
}
