import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { openStore } from './helpers.js';
import {Reactions} from '../src/reactions.js';
import {Facebook} from '../src/facebook.js';
import {Workflow} from '../src/workflow.js';
function setup(t,source='facebook'){
  const dir=mkdtempSync(join(tmpdir(),'studio-reactions-')),store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveSettings({...store.settings(),live:true,pageId:'123',graphVersion:'v26.0'});
  store.add({id:'c1',post_id:'123_456',author:'Alex',message:'Great!',source});
  store.update('c1',{draft:'Thanks!',status:'pending'});
  let likes=0;
  const fb={verify:async()=>{},current:async()=>({message:'Great!'}),like:async()=>{likes++;}};
  return {store,fb,reactions:new Reactions(store,fb),likes:()=>likes};
}
test('Like is gated by confirmed publication, idempotent, and independent of publishing mode',async t=>{
 const s=setup(t);await assert.rejects(s.reactions.afterPublication('c1'),/confirmed/);assert.equal(s.likes(),0);
 s.store.update('c1',{status:'published'});await s.reactions.afterPublication('c1');await s.reactions.afterPublication('c1');assert.equal(s.likes(),1);assert.equal(s.store.get('c1').reaction_applied,'LIKE');
});
test('test reply Likes are simulated without Facebook calls',async t=>{
 const s=setup(t,'test');s.store.update('c1',{status:'simulated'});s.fb.verify=async()=>{throw new Error('Facebook called');};await s.reactions.afterPublication('c1');assert.equal(s.likes(),0);assert.equal(s.store.get('c1').reaction_status,'simulated');
});
test('unknown Like outcomes stay uncertain and cannot be resent automatically',async t=>{
 const s=setup(t);s.store.update('c1',{status:'published'});s.fb.like=async()=>{throw new Error('timeout');};await assert.rejects(s.reactions.afterPublication('c1'),/timeout/);assert.equal(s.store.get('c1').status,'published');assert.equal(s.store.get('c1').reaction_status,'uncertain');await assert.rejects(s.reactions.afterPublication('c1'),/Check/);
});
test('simultaneous Like attempts cannot duplicate a Like',async t=>{
 const s=setup(t);s.store.update('c1',{status:'published'});let release;s.fb.like=()=>new Promise(r=>{release=r;});const first=s.reactions.afterPublication('c1');await new Promise(r=>setImmediate(r));await assert.rejects(s.reactions.afterPublication('c1'),/already/);release();await first;
});
test('drafting always selects Like and does not apply it before publication',async t=>{
 const s=setup(t,'test');s.store.update('c1',{status:'queued',draft:''});const ai={generate:async()=>({reply_decision:'REPLY',reply:'Thanks for sharing!',needs_review:false,reaction:'CARE'})};const workflow=new Workflow(s.store,ai,s.fb);await workflow.generate('c1');assert.equal(s.store.get('c1').reaction_choice,'LIKE');assert.equal(s.likes(),0);
});
test('Like API refuses to silently replace Heart/Care and handles already-liked comments without a POST',async t=>{
  const s=setup(t);let requests=[];let existing='CARE';
  const facebook=new Facebook(s.store,{get:()=> 'test-token'},async(url,options)=>{requests.push(options.method);return Response.json({summary:{viewer_reaction:existing}});});
  await assert.rejects(facebook.like(s.store.get('c1')),/different/);assert.deepEqual(requests,['GET']);
  existing='LIKE';requests=[];await facebook.like(s.store.get('c1'));assert.deepEqual(requests,['GET']);
});
test('Like API uses the supported likes edge and requires a success confirmation',async t=>{
  const s=setup(t);let calls=[];
  const facebook=new Facebook(s.store,{get:()=> 'test-token'},async(url,options)=>{calls.push({path:url.pathname,method:options.method});return Response.json(options.method==='GET'?{summary:{viewer_reaction:'NONE'}}:{success:true});});
  await facebook.like(s.store.get('c1'));assert.deepEqual(calls,[{path:'/v26.0/c1/reactions',method:'GET'},{path:'/v26.0/c1/likes',method:'POST'}]);
});
