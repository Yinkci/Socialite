import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareUsage } from '../src/cloudflare-usage.js';
const now=Date.parse('2026-10-12T03:00:00Z');
test('analytics is shared for five minutes, resets at UTC midnight and never returns its token',async()=>{
  let calls=0;const usage=new CloudflareUsage('account','private-token',async(url,options)=>{
    calls++;const body=JSON.parse(options.body);assert.equal(body.variables.start,'2026-10-12T00:00:00Z');assert.match(options.headers.Authorization,/private-token/);
    return {ok:true,json:async()=>({data:{viewer:{accounts:[{durableObjectsPeriodicGroups:[{sum:{rowsRead:170113,rowsWritten:656}}]}]}}})};
  });
  const [a,b]=await Promise.all([usage.read(now),usage.read(now)]);assert.equal(calls,1);assert.equal(a,b);
  assert.equal(a.reads,170113);assert.equal(a.resetAt,Date.parse('2026-10-13T00:00:00Z'));assert.ok(!JSON.stringify(a).includes('private-token'));
  await usage.read(now+299999);assert.equal(calls,1);await usage.read(now+300000);assert.equal(calls,2);
});
test('analytics failures are cached and same-day totals are marked stale',async()=>{
  let calls=0,fail=false;const usage=new CloudflareUsage('account','token',async()=>{calls++;return {ok:true,json:async()=>fail?{errors:[{message:'permission denied'}]}:{data:{viewer:{accounts:[{durableObjectsPeriodicGroups:[{sum:{rowsRead:10,rowsWritten:2}}]}]}}}};});
  await usage.read(now);fail=true;const stale=await usage.read(now+300000);assert.equal(stale.reads,10);assert.equal(stale.stale,true);
  await usage.read(now+300001);assert.equal(calls,2);
  const nextDay=await usage.read(Date.parse('2026-10-13T01:00:00Z'));assert.equal(nextDay.available,false);assert.equal(nextDay.reads,undefined,'yesterday is never shown as today');
});
test('missing analytics credential shows unavailable without making a request',async()=>{
  const usage=new CloudflareUsage('account','',()=>{throw Error('must not fetch');});const result=await usage.read(now);assert.equal(result.available,false);
});
