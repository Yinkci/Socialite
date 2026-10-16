const TTL=5*60*1000,RETRY=60*1000;
const METRIC='monetization_approximate_earnings';
function failure(error){
  const code=error.facebookCode;
  if(code===190)return 'Your Facebook Page token has expired or is invalid. Update it in Connections.';
  if(code===10||code===200)return 'Meta denied earnings access. Check read_insights and pages_read_engagement permissions on your Page token.';
  if(code===100)return 'Meta rejected the approximate earnings metric or period (code 100). This is not a zero balance.';
  return 'Meta could not load approximate earnings'+(Number.isInteger(code)?' (code '+code+')':'')+'. Try again shortly.';
}

// Use the approximate earnings metric directly. The separate content earnings
// metric has a different monetary scale; its microAmount is never used here.
export function earningsValue(value){
  if(typeof value!=='number'||!Number.isFinite(value))throw Error('Meta returned approximate earnings in an unsupported monetary format. No amount has been assumed.');
  return value;
}

export class Earnings {
  constructor(facebook){this.facebook=facebook;this.cache=null;}
  read(now=Date.now(),refresh=false){
    const fb=this.facebook,s=fb.store.settings(),token=fb.vault.get('facebookToken');
    const month=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit'});
    const key=JSON.stringify([s.pageId,s.graphVersion,token,month]);
    if(this.cache?.key===key&&now<this.cache.until&&(!refresh||now<this.cache.started+RETRY))return this.cache.pending;
    const pending=this.load(s.pageId,now).then(result=>{
      const current=fb.store.settings();
      if(current.pageId!==s.pageId||current.graphVersion!==s.graphVersion||fb.vault.get('facebookToken')!==token)return {available:false,error:'Facebook connection changed. Reload to fetch earnings.'};
      if(this.cache?.pending===pending&&(!result.available||result.warning))this.cache.until=now+RETRY;
      return result;
    });
    this.cache={key,started:now,until:now+TTL,pending};
    return pending;
  }
  async load(pageId,now){
    if(!this.facebook.configured())return {available:false,error:'Connect your Facebook Page to load earnings.',retryAfterSeconds:60};
    const read=metric=>this.facebook.request(pageId+'/insights','GET',{metric,period:'day',date_preset:'this_month'});
    const [approximate,content]=await Promise.allSettled([read(METRIC),read('content_monetization_earnings')]);
    if(approximate.status==='rejected')return {available:false,error:failure(approximate.reason),errorCode:approximate.reason.facebookCode,retryAfterSeconds:60};
    const rows=approximate.value.data?.find(m=>m.name===METRIC)?.values;
    if(!rows?.length){
      const permissions=await this.facebook.insightsPermissions?.();
      if(permissions&&(!permissions.readInsights||!permissions.readEngagement)){
        const missing=[...(!permissions.readInsights?['read_insights']:[]),...(!permissions.readEngagement?['pages_read_engagement']:[])];
        return {available:false,error:'Your saved Page token is missing '+missing.join(' and ')+'. Generate a new Page access token with these permissions, then save it in Connections.',missingPermissions:missing,retryAfterSeconds:60};
      }
      return {available:false,error:'Meta returned no approximate earnings for this month through its API. Earnings visible in Facebook may not yet be available to this app.',retryAfterSeconds:60};
    }
    try{
      const values=[...new Map(rows.map(row=>{
        const endAt=Date.parse(row.end_time),amount=earningsValue(row.value);
        if(!Number.isFinite(endAt))throw Error('Meta returned an unsupported earnings date.');
        return [endAt,{endAt,amount}];
      })).values()].sort((a,b)=>a.endAt-b.endAt);
      // Currency metadata comes from the same Page/date range. Never infer a
      // currency from the viewer's locale or convert the other metric's amount.
      const metadata=content.status==='fulfilled'?content.value.data?.find(m=>m.name==='content_monetization_earnings')?.values:[];
      const currencies=new Set((metadata||[]).map(row=>row.value?.currency).filter(c=>typeof c==='string'&&/^[A-Z]{3}$/.test(c)));
      if(currencies.size>1)throw Error('Meta returned mixed earnings currencies. No total has been assumed.');
      const currency=currencies.size===1?[...currencies][0]:null;
      const amount=values.reduce((sum,row)=>sum+row.amount,0);
      if(!Number.isFinite(amount))throw Error('Meta returned an unsupported earnings total.');
      const month=new Date(now).toLocaleDateString('en-SG',{timeZone:'America/Los_Angeles',month:'long'});
      return {available:true,amount,currency,values,endAt:values.at(-1).endAt,updatedAt:now,source:'daily',period:'this_month',periodLabel:month+' earnings',reportedDays:values.length,metric:METRIC,
        ...(!currency?{warning:'Meta did not supply the currency. The amount is shown without a currency symbol.'}:{}),retryAfterSeconds:currency?300:60};
    }catch(error){return {available:false,error:error.message,retryAfterSeconds:60};}
  }
}
