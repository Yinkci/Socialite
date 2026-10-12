const TTL=5*60*1000;
export class CloudflareUsage {
  constructor(account,token,fetcher=(...args)=>fetch(...args)){this.account=account;this.token=token;this.fetch=fetcher;this.cache=null;this.nextAt=0;this.pending=null;}
  async read(now=Date.now()){
    const day=new Date(now).toISOString().slice(0,10),resetAt=Date.parse(day+'T00:00:00Z')+86400e3;
    if(!this.token||!this.account)return {available:false,error:'Cloudflare analytics is not connected.',resetAt};
    if(this.cache&&now<this.nextAt&&this.cache.resetAt===resetAt)return this.cache;
    if(this.pending)return this.pending;
    this.pending=this.load(now,day,resetAt).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async load(now,day,resetAt){
    try{
      const query=`query Usage($account: string!, $start: Time!, $end: Time!){viewer{accounts(filter:{accountTag:$account}){durableObjectsPeriodicGroups(limit:1,filter:{datetime_geq:$start,datetime_lt:$end}){sum{rowsRead rowsWritten}}}}}`;
      const response=await this.fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{account:this.account,start:day+'T00:00:00Z',end:new Date(now).toISOString()}}),signal:AbortSignal.timeout(15000)});
      const data=await response.json();
      if(!response.ok||data.errors?.length||!data.data?.viewer?.accounts?.length)throw Error('Cloudflare usage could not be refreshed.');
      const groups=data.data.viewer.accounts[0].durableObjectsPeriodicGroups;
      if(!Array.isArray(groups))throw Error('Cloudflare usage could not be refreshed.');
      const reads=groups.reduce((n,g)=>n+Number(g.sum.rowsRead),0),writes=groups.reduce((n,g)=>n+Number(g.sum.rowsWritten),0);
      if(!Number.isSafeInteger(reads)||reads<0||!Number.isSafeInteger(writes)||writes<0)throw Error('Cloudflare returned invalid usage.');
      this.cache={available:true,stale:false,reads,writes,readLimit:5000000,writeLimit:100000,updatedAt:now,resetAt};
    }catch{
      // Preserve a same-day reading with an explicit stale label; never present yesterday's usage as today's.
      this.cache=this.cache?.available&&this.cache.resetAt===resetAt?{...this.cache,stale:true,error:'Cloudflare usage could not be refreshed.'}:{available:false,error:'Cloudflare usage could not be refreshed.',resetAt};
    }
    this.nextAt=now+TTL;
    return this.cache;
  }
}
