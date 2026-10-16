import test from 'node:test';
import assert from 'node:assert/strict';
import { Earnings, earningsValue } from '../src/earnings.js';
const now=Date.parse('2026-10-16T08:00:00Z');
const row=(value,end_time='2026-10-16T07:00:00+0000')=>({value,end_time});
function fixture(){
  let token='secret',settings={pageId:'123',graphVersion:'v26.0'};
  const calls=[];
  const facebook={store:{settings:()=>settings},vault:{get:()=>token},configured:()=>true,request:async(path,method,args)=>{
    calls.push({path,method,args});return {data:[{name:args.metric,period:'day',values:[row(args.metric==='monetization_approximate_earnings'?.97:{currency:'USD',microAmount:97000000})]}]};
  }};
  return {facebook,calls,earnings:new Earnings(facebook),changePage:()=>{settings={...settings,pageId:'456'};},changeToken:()=>{token='new-secret';}};
}
test('real Meta monetary formats produce USD 0.97, without rescaling microAmount',async()=>{
  const f=fixture(),[a,b]=await Promise.all([f.earnings.read(now),f.earnings.read(now)]);
  assert.deepEqual(a,b);assert.equal(a.amount,.97);assert.equal(a.values[0].amount,.97);assert.equal(a.currency,'USD');assert.equal(a.periodLabel,'October earnings');assert.equal(a.metric,'monetization_approximate_earnings');assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(c=>c.path==='123/insights'&&c.args.period==='day'&&c.args.date_preset==='this_month'));
  assert.ok(!JSON.stringify(a).includes('secret'));await f.earnings.read(now+299999);assert.equal(f.calls.length,2);await f.earnings.read(now+5*60*1000);assert.equal(f.calls.length,4);assert.equal(a.retryAfterSeconds,300);
});
test('daily amounts sum once per date for the current month',async()=>{
  const f=fixture(),request=f.facebook.request;
  f.facebook.request=async(path,method,args)=>args.metric==='content_monetization_earnings'?request(path,method,args):{data:[{name:args.metric,values:[row(.86,'2026-10-15T07:00:00Z'),row(.11),row(.11)]}]};
  const a=await f.earnings.read(now);assert.equal(a.amount,.97);assert.equal(a.reportedDays,2);assert.equal(a.values.length,2);
});
test('a failed currency lookup does not discard valid approximate earnings or guess a currency',async()=>{
  const f=fixture(),request=f.facebook.request;f.facebook.request=async(path,method,args)=>{if(args.metric==='content_monetization_earnings')throw Error('permission');return request(path,method,args);};
  const result=await f.earnings.read(now);assert.equal(result.available,true);assert.equal(result.amount,.97);assert.equal(result.currency,null);assert.match(result.warning,/without a currency symbol/);
});
test('cache is isolated by Page and token, including connection changes in flight',async()=>{
  const f=fixture();await f.earnings.read(now);f.changePage();await f.earnings.read(now+1);assert.equal(f.calls.length,4);assert.equal(f.calls[2].path,'456/insights');
  f.changeToken();await f.earnings.read(now+2);assert.equal(f.calls.length,6);
  const g=fixture();const old=g.earnings.read(now);g.changePage();assert.equal((await old).available,false);
});
test('missing, malformed, and mixed currency results never become a zero balance',async()=>{
  assert.throws(()=>earningsValue({microAmount:97000000,currency:'USD'}));assert.throws(()=>earningsValue('0.97'));assert.throws(()=>earningsValue(Infinity));
  for(const values of [[],[row('0.97')],[row(.97,'bad')]]){
    const f=fixture(),request=f.facebook.request;f.facebook.request=async(path,method,args)=>args.metric==='content_monetization_earnings'?request(path,method,args):{data:[{name:args.metric,values}]};
    const result=await f.earnings.read(now);assert.equal(result.available,false);assert.equal(result.amount,undefined);
  }
  const f=fixture(),request=f.facebook.request;f.facebook.request=async(path,method,args)=>args.metric==='content_monetization_earnings'?{data:[{name:args.metric,values:[row({currency:'USD'}),row({currency:'EUR'})]}]}:request(path,method,args);
  assert.equal((await f.earnings.read(now)).available,false);
});
test('zero is a valid estimate, and unconfigured Pages make no requests',async()=>{
  const f=fixture(),request=f.facebook.request;f.facebook.request=async(path,method,args)=>args.metric==='content_monetization_earnings'?request(path,method,args):{data:[{name:args.metric,values:[row(0)]}]};assert.equal((await f.earnings.read(now)).amount,0);
  const g=fixture();g.facebook.configured=()=>false;assert.equal((await g.earnings.read(now)).available,false);assert.equal(g.calls.length,0);
});
test('empty results identify missing permission and expire after one minute',async()=>{
  const f=fixture();let calls=0;f.facebook.request=async()=>{calls++;return {data:[]};};f.facebook.insightsPermissions=async()=>({readInsights:false,readEngagement:true});
  const result=await f.earnings.read(now);assert.equal(result.available,false);assert.deepEqual(result.missingPermissions,['read_insights']);assert.match(result.error,/missing read_insights/);
  await f.earnings.read(now+59000,true);assert.equal(calls,2);await f.earnings.read(now+60000);assert.equal(calls,4);
});
test('explicit refresh is rate limited and a new reporting month invalidates the cache',async()=>{
  const f=fixture();await f.earnings.read(now);await f.earnings.read(now+60000,true);assert.equal(f.calls.length,4);
  const boundary=Date.parse('2026-11-01T07:00:00Z');const g=fixture();await g.earnings.read(boundary-1000);await g.earnings.read(boundary+1000);assert.equal(g.calls.length,4);
});
test('upstream errors are classified without leaking private Meta messages',async()=>{
  for(const [code,message] of [[190,/expired/],[200,/denied/],[100,/rejected/],[4,/code 4/]]){
    const f=fixture();f.facebook.request=async()=>{throw Object.assign(Error('private token'),{facebookCode:code});};
    const result=await f.earnings.read(now);assert.equal(result.available,false);assert.equal(result.errorCode,code);assert.match(result.error,message);assert.ok(!result.error.includes('private token'));
  }
});
