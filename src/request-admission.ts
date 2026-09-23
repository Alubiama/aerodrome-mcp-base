// Single-instance admission. Peer identity uses the socket, never spoofable headers.
// Behind a proxy this deliberately groups peers until a trusted proxy policy is verified.
export class RequestAdmission {
 private clients=new Map<string,{count:number;active:number;until:number}>();
 private active=0;private count=0;private until=0;
 constructor(private now=Date.now){}
 acquire(peer:string):(()=>void)|null {
  const now=this.now();
  for(const [key,row] of this.clients)if(row.until<=now&&row.active===0)this.clients.delete(key);
  if(now>=this.until){this.count=0;this.until=now+60000;}
  let row=this.clients.get(peer);
  if(!row){if(this.clients.size>=4096)return null;row={count:0,active:0,until:now+60000};this.clients.set(peer,row)}
  if(now>=row.until){row.count=0;row.until=now+60000;}
  if(row.active>=1||this.active>=2||row.count>=30||this.count>=60)return null;
  row.active++;row.count++;this.active++;this.count++;
  let released=false;return ()=>{if(!released){released=true;row!.active--;this.active--;}};
 }
}
