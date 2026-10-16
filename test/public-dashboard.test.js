import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { publicDashboard } from '../src/public-dashboard.js';
import { sha256 } from '../src/auth.js';

// Only the runtime base class is mocked; requests run through the real Worker
// router, session checks, database adapter and public response builder.
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }',shortCircuit:true};
  return next(specifier,context);
}});
const {SocialiteApp}=await import('../src/index.js');
function app(t){
  const db=new DatabaseSync(':memory:'),kv=new Map();let alarm=null;
  t.after(()=>db.close());
  const storage={kv:{get:k=>kv.get(k),put:(k,v)=>kv.set(k,v),delete:k=>kv.delete(k),list:()=>kv},
    getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},sql:{exec(query,...args){
      const rows=args.length||/^\s*(select|pragma)/i.test(query)&&!query.includes(';')?db.prepare(query).all(...args):(db.exec(query),[]);
      return {toArray:()=>rows,one:()=>rows[0]};
    }}};
  return new SocialiteApp({storage},{PUBLIC_URL:'https://socialite.test'});
}
const request=(path,options={})=>new Request('https://socialite.test'+path,options);

test('public projection includes only automatically published replies while excluding secrets and unpublished conversations',()=>{
  const snapshot={csrf:'SECRET',settings:{pageId:'123',mode:'hybrid',personality:'SECRET',hfSpace:'SECRET'},facebook:{pageName:'Page',verifyToken:'SECRET',hasToken:true},chatgpt:{enabled:true,email:'SECRET'},live:{on:true,target:'SECRET'},activity:[{message:'SECRET'}],tabCounts:{automatic:1},kpiTimes:{automatic:[]}};
  const rows=[{id:'one',source:'facebook',status:'published',publish_kind:'automatic',message:'Public',draft:'Published reply',reason:'SECRET',error:'SECRET',thread_history:'SECRET',author_id:'SECRET'},
    {id:'pending',source:'facebook',status:'pending',publish_kind:'automatic'},
    {id:'approved',source:'facebook',status:'published',publish_kind:'approved'},
    {id:'test',source:'test',status:'published',publish_kind:'automatic'},
    {id:'cleared',source:'facebook',status:'published',publish_kind:'automatic',cleared_at:123}];
  const data=publicDashboard(snapshot,rows,{available:false,error:'SECRET'});
  assert.deepEqual(data.comments.map(c=>c.id),['one']);assert.equal(data.readOnly,true);
  assert.ok(!JSON.stringify(data).includes('SECRET'));assert.equal(data.csrf,undefined);
});

test('real anonymous routes cannot write, access owner state, memory, credentials or imports',async t=>{
  const a=app(t);a.vault.set('passwordHash','configured');a.vault.set('verifyToken','PRIVATE-VERIFY');
  a.store.add({id:'automatic',source:'facebook',message:'Public comment'});
  a.store.update('automatic',{status:'published',publish_kind:'automatic',draft:'Public reply'});
  a.store.add({id:'manual',source:'facebook',message:'Public manual comment'});
  a.store.update('manual',{status:'published',publish_kind:'approved',draft:'Public approved reply',published_at:Date.now()+1});
  a.store.add({id:'pending',source:'facebook',message:'PRIVATE-COMMENT'});
  const publicResponse=await a.fetch(request('/api/public-state'));assert.equal(publicResponse.status,200);
  const data=await publicResponse.json();assert.deepEqual(data.comments.map(c=>c.id),['automatic']);
  assert.ok(!JSON.stringify(data).includes('PRIVATE-'));assert.equal(data.csrf,undefined);
  const etag=publicResponse.headers.get('etag');
  assert.equal((await a.fetch(request('/api/public-state',{headers:{'If-None-Match':etag}}))).status,304);
  const before=a.store.db.revision;
  // Exercise every literal mutation route, even with a forged cookie/CSRF token.
  const source=readFileSync('src/index.js','utf8');
  const paths=new Set([...source.matchAll(/['"](\/api\/[a-z-]+(?:\/[a-z-]+)?)['"]/g)].map(m=>m[1]));
  for(const path of paths){
    if(['/api/login','/api/logout','/api/auth-status'].includes(path))continue;
    for(const cookie of ['', 'sid=forged-session-that-is-long-enough']){
      const response=await a.fetch(request(path,{method:'POST',headers:{origin:'https://socialite.test','Content-Type':'application/json','X-CSRF-Token':'forged',cookie},body:JSON.stringify({id:'automatic',on:true,draft:'Unauthorized',mode:'automatic'})}));
      assert.equal(response.status,401,path);
    }
  }
  for(const path of ['/api/state','/api/memory','/api/cloudflare','/api/earnings'])assert.equal((await a.fetch(request(path))).status,401,path);
  for(const path of ['/internal/import','/internal/import-chatgpt','/internal/wake'])assert.equal((await a.fetch(request(path,{method:'POST',body:'{}'}))).status,404,path);
  assert.equal(a.store.db.revision,before);assert.equal(a.store.get('automatic').draft,'Public reply');
});

test('valid owner sessions retain access; expired sessions and missing CSRF cannot mutate',async t=>{
  const a=app(t),sid='valid-owner-session-long-enough';
  a.ctx.storage.kv.put('session:'+sha256(sid),{csrf:'owner-csrf',expires:Date.now()+60000});
  const cookie='sid='+sid;
  const response=await a.fetch(request('/api/state',{headers:{cookie}}));assert.equal(response.status,200);
  assert.equal((await response.json()).csrf,'owner-csrf');
  const post=(csrf)=>request('/api/settings',{method:'POST',headers:{cookie,origin:'https://socialite.test','Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({mode:'hybrid'})});
  assert.equal((await a.fetch(post('wrong'))).status,403);
  assert.equal((await a.fetch(post('owner-csrf'))).status,200);assert.equal(a.store.settings().mode,'hybrid');
  a.ctx.storage.kv.put('session:'+sha256(sid),{csrf:'owner-csrf',expires:Date.now()-1});
  assert.equal((await a.fetch(post('owner-csrf'))).status,401);
});

test('earnings requires a valid session and is never included in the public snapshot',async t=>{
  const a=app(t),sid='earnings-owner-session-long-enough';let calls=0;
  a.earnings.read=async()=>{calls++;return {available:true,amount:987.65,currency:'USD',values:[]};};
  a.ctx.storage.kv.put('session:'+sha256(sid),{csrf:'csrf',expires:Date.now()+60000});
  const response=await a.fetch(request('/api/earnings',{headers:{cookie:'sid='+sid}}));
  assert.equal(response.status,200);assert.equal((await response.json()).amount,987.65);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(calls,1);
  const publicResponse=await a.fetch(request('/api/public-state'));assert.ok(!JSON.stringify(await publicResponse.json()).includes('987.65'));assert.equal(calls,1);
  a.ctx.storage.kv.put('session:'+sha256(sid),{expires:Date.now()-1});
  assert.equal((await a.fetch(request('/api/earnings',{headers:{cookie:'sid='+sid}}))).status,401);assert.equal(calls,1);
});


test('owner-supplied creation date is public and tied to its Facebook Page',async t=>{
  const a=app(t);a.env.PAGE_CREATED_ID='123';a.env.PAGE_CREATED_AT='2026-09-12T14:00:00+08:00';
  a.store.saveSettings({...a.store.settings(),pageId:'123'});
  let response=await a.fetch(request('/api/public-state'));
  assert.equal((await response.json()).facebook.pageCreatedAt,Date.parse('2026-09-12T06:00:00Z'));
  a.store.saveSettings({...a.store.settings(),pageId:'456'});
  response=await a.fetch(request('/api/public-state'));
  assert.equal((await response.json()).facebook.pageCreatedAt,null);
});

test('authenticated legacy transfer shares +590 with visitors without exposing a public write',async t=>{
  const a=app(t),now=Date.now(),sid='valid-owner-follower-session';
  a.vault.set('facebookToken','test-token');
  a.store.saveSettings({...a.store.settings(),pageId:'123',graphVersion:'v26.0',facebookPage:{id:'123',name:'Page',followersCount:8971,followersUpdatedAt:now}});
  a.ctx.storage.kv.put('session:'+sha256(sid),{csrf:'owner-csrf',expires:now+60000});
  const input={pageId:'123',readings:[[now-24*3600e3,8381],[now,8971]]};
  const options={method:'POST',headers:{origin:'https://socialite.test','Content-Type':'application/json','X-CSRF-Token':'owner-csrf',cookie:'sid='+sid},body:JSON.stringify(input)};
  assert.equal((await a.fetch(request('/api/facebook/follower-history',{...options,headers:{...options.headers,cookie:''}}))).status,401);
  assert.equal((await a.fetch(request('/api/facebook/follower-history',options))).status,200);
  const publicData=await (await a.fetch(request('/api/public-state'))).json();
  const ownerData=await (await a.fetch(request('/api/state',{headers:{cookie:'sid='+sid}}))).json();
  assert.equal(publicData.facebook.followersDelta24h,590);assert.equal(ownerData.facebook.followersDelta24h,590);
  assert.deepEqual(publicData.facebook.followersHistory,ownerData.facebook.followersHistory);
  assert.equal(publicData.facebook.hasToken,undefined);
});

test('real transfer accepts short history after Facebook refreshes and returns a consistent count',async t=>{
  const a=app(t),now=Date.now(),sid='owner-short-follower-session';
  a.vault.set('facebookToken','test-token');
  a.store.saveSettings({...a.store.settings(),pageId:'123',graphVersion:'v26.0',facebookPage:{id:'123',name:'Page',followersCount:8974,followersUpdatedAt:now,followersHistory:[[now-60000,8971],[now,8974]]}});
  a.ctx.storage.kv.put('session:'+sha256(sid),{csrf:'owner-csrf',expires:now+60000});
  const response=await a.fetch(request('/api/facebook/follower-history',{method:'POST',headers:{cookie:'sid='+sid,origin:'https://socialite.test','Content-Type':'application/json','X-CSRF-Token':'owner-csrf'},body:JSON.stringify({pageId:'123',readings:[[now-10*3600e3,8381],[now-60000,8971]]})}));
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.followersCount,8974);assert.equal(result.followersObservedChange,593);assert.equal(result.followersDelta24h,null);
  const publicData=await (await a.fetch(request('/api/public-state'))).json();
  assert.equal(publicData.facebook.followersObservedChange,593);assert.equal(publicData.facebook.followersCount,8974);
});

test('replacing a token preserves history for the same Page and switching Pages clears it',async t=>{
  const a=app(t),now=Date.now(),sid='owner-preserve-follower-history';
  const page={id:'123',name:'Page',followersCount:10176,followersUpdatedAt:now,followersHistory:[[now-3600e3,10170],[now,10176]]};
  a.store.saveSettings({...a.store.settings(),pageId:'123',graphVersion:'v26.0',live:true,facebookPage:page});a.vault.set('facebookToken','old-token');
  a.ctx.storage.kv.put('session:'+sha256(sid),{csrf:'csrf',expires:now+60000});
  let atVerify;a.facebook.verify=async()=>{atVerify=a.store.settings().facebookPage;return {id:'123',name:'Page'};};
  const save=input=>a.fetch(request('/api/facebook/save',{method:'POST',headers:{cookie:'sid='+sid,origin:'https://socialite.test','Content-Type':'application/json','X-CSRF-Token':'csrf'},body:JSON.stringify(input)}));
  assert.equal((await save({pageId:'123',pageToken:'replacement-token'})).status,200);
  assert.deepEqual(atVerify,page);assert.deepEqual(a.store.settings().facebookPage,page);assert.equal(a.vault.get('facebookToken'),'replacement-token');
  a.store.saveSettings({...a.store.settings(),live:false});
  assert.equal((await save({pageId:'456',pageToken:'other-page-token'})).status,200);assert.equal(a.store.settings().facebookPage,null);
});
