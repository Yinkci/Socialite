import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from './helpers.js';
import {Facebook} from '../src/facebook.js';
import {Workflow} from '../src/workflow.js';
import {buildPrompt} from '../src/prompt.js';

const post='123_456',root='456_100',pageReply='456_200',followup='456_300';
const pageMessage={id:pageReply,message:'Glad this helped you.',from:{id:'123',name:'Our Page'},parent:{id:root},created_time:'2026-10-12T01:00:00Z'};
const latest={id:followup,message:'Can you explain a little more?',from:{id:'999',name:'Alex'},parent:{id:pageReply},created_time:'2026-10-12T02:00:00Z'};
const event=(extra={})=>({object:'page',entry:[{id:'123',changes:[{field:'feed',value:{item:'comment',verb:'add',comment_id:followup,post_id:post,parent_id:pageReply,message:latest.message,from:latest.from,...extra}}]}]});
function setup(t,known=true){
  const dir=mkdtempSync(join(tmpdir(),'socialite-threads-'));let store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveSettings({...store.settings(),pageId:'123',graphVersion:'v26.0',live:true,mode:'automatic'});
  if(known){store.add({id:root,post_id:post,author:'Alex',message:'This helped me.',source:'facebook'});store.update(root,{status:'published',draft:pageMessage.message,reply_id:pageReply,published_at:1});}
  const graph=new Map([[root,{id:root,message:'This helped me.',from:latest.from,created_time:'2026-10-12T00:00:00Z'}],[pageReply,pageMessage],[followup,latest],[root+'/comments',{data:[pageMessage]}],[followup+'/comments',{data:[]}]]);
  const facebook=new Facebook(store,{get:()=> 'test'});facebook.request=async path=>{if(!graph.has(path))throw Error('Missing Graph fixture: '+path);return structuredClone(graph.get(path));};
  facebook.verify=async()=>({id:'123'});facebook.context=async()=> 'Post context';facebook.post=async()=>({caption:'Post context',url:'https://facebook.com/post',image:''});
  let posted=0;facebook.publish=async()=>{posted++;return {id:'456_400'};};facebook.like=async()=>{};
  let received;const ai={status:()=>({enabled:true}),generate:async(s,c)=>{received=c;return {reply:'Here is a little more context for you.',reply_decision:'REPLY',needs_review:false};}};
  const workflow=new Workflow(store,ai,facebook);
  return {store,facebook,graph,workflow,ai,posted:()=>posted,received:()=>received,restart(){store.close();store=openStore(dir);return store;}};
}
test('follow-ups link their original comment and Page reply, deduplicate retries and exclude Page messages',async t=>{
  const s=setup(t);assert.equal(await s.facebook.ingestWithThreads(event()),1);
  const c=s.store.get(followup);assert.equal(c.is_followup,1);assert.equal(c.manual_hold,1);assert.equal(c.parent_id,pageReply);assert.equal(c.thread_root,root);
  const history=JSON.parse(c.thread_history);assert.ok(history.some(m=>m.message==='This helped me.'));assert.ok(history.some(m=>m.isPage&&m.message===pageMessage.message));
  assert.equal(await s.facebook.ingestWithThreads(event()),0);
  assert.equal(await s.facebook.ingestWithThreads(event({comment_id:'300'})),0,'alternate ID form is deduplicated');
  assert.equal(await s.facebook.ingestWithThreads(event({comment_id:'456_400',from:{id:'123'}})),0);
  assert.equal(await s.facebook.ingestWithThreads(event({comment_id:pageReply,from:undefined})),0,'recorded Page reply never becomes inbound work');
});
test('a reply written directly on Facebook is detected, including flattened thread parents',async t=>{
  const s=setup(t,false);assert.equal(await s.facebook.ingestWithThreads(event({parent_id:root})),1);
  assert.equal(s.store.get(followup).thread_root,root);assert.ok(JSON.parse(s.store.get(followup).thread_history).some(m=>m.isPage));
});
test('threads without a prior Page reply are ignored and unavailable context is held for investigation',async t=>{
  const s=setup(t,false);s.graph.set(root+'/comments',{data:[]});assert.equal(await s.facebook.ingestWithThreads(event({parent_id:root})),0);
  s.graph.delete(pageReply);assert.equal(await s.facebook.ingestWithThreads(event()),1);assert.equal(s.store.get(followup).status,'error');assert.equal(s.store.get(followup).manual_hold,1);assert.equal(s.posted(),0);
});
test('all publishing modes hold follow-ups, including regenerated drafts, skipped suggestions and altered hold flags',async t=>{
  for(const mode of ['approval','hybrid','automatic']){
    const s=setup(t);s.store.saveSettings({...s.store.settings(),mode});await s.facebook.ingestWithThreads(event());await s.workflow.tick();
    assert.equal(s.store.get(followup).status,'pending');assert.equal(s.posted(),0);
    assert.ok(s.received().conversationHistory.some(m=>m.isPage));assert.ok(buildPrompt(s.store.settings(),s.received()).requestInput.conversation_history.length);
    s.store.update(followup,{manual_hold:0,review:0});assert.equal(s.store.nextPublish('automatic'),undefined);await s.workflow.publish(followup,undefined,true);assert.equal(s.posted(),0);
    s.ai.generate=async()=>({reply:'',reply_decision:'SKIP',needs_review:false,reason:'No reply suggested.'});await s.workflow.generate(followup);assert.equal(s.store.get(followup).status,'pending');assert.equal(s.store.get(followup).manual_hold,1);
    const restarted=s.restart();assert.equal(restarted.get(followup).is_followup,1);assert.equal(restarted.nextPublish('automatic'),undefined);
  }
});
test('manual approval publishes a follow-up once and a further reply remains held',async t=>{
  const s=setup(t);await s.facebook.ingestWithThreads(event());await s.workflow.tick();s.workflow.lastPublish=0;
  await s.workflow.publish(followup);assert.equal(s.posted(),1);await assert.rejects(s.workflow.publish(followup),/Only pending/);
  s.graph.set(followup+'/comments',{data:[{id:'456_400',message:'Here is more context.',from:{id:'123'},parent:{id:followup},created_time:'2026-10-12T03:00:00Z'}]});
  assert.equal(await s.facebook.ingestWithThreads(event({comment_id:'456_500',parent_id:'456_400',message:'Thanks, another question.'})),1);
  assert.equal(s.store.get('456_500').is_followup,1);assert.equal(s.store.get('456_500').manual_hold,1);
});
test('a Page reply already posted directly on Facebook prevents another send',async t=>{
  const s=setup(t);await s.facebook.ingestWithThreads(event());await s.workflow.tick();s.workflow.lastPublish=0;
  s.graph.set(followup+'/comments',{data:[{id:'456_external',message:'Answered manually on Facebook.',from:{id:'123'},parent:{id:followup},created_time:'2026-10-12T03:00:00Z'}]});
  await s.workflow.publish(followup);assert.equal(s.posted(),0);assert.equal(s.store.get(followup).reply_id,'456_external');assert.equal(s.store.get(followup).publish_kind,'external');
});

test('concurrent webhook retries with alternate IDs create only one follow-up',async t=>{
  const s=setup(t);const results=await Promise.all([s.facebook.ingestWithThreads(event()),s.facebook.ingestWithThreads(event({comment_id:'300'}))]);
  assert.equal(results.reduce((a,b)=>a+b,0),1);assert.equal(s.store.list().filter(c=>c.is_followup).length,1);
});

test('Page messages with omitted webhook authors are checked against Facebook and ignored',async t=>{
  const s=setup(t);s.graph.set('456_600',{id:'456_600',from:{id:'123'}});
  assert.equal(await s.facebook.ingestWithThreads(event({comment_id:'456_600',from:undefined})),0);assert.equal(s.store.get('456_600'),undefined);
});

test('a follow-up discovered during automatic publication is held before any send',async t=>{
  const s=setup(t);s.store.add({id:followup,post_id:post,author:'Alex',message:latest.message,source:'facebook'});
  s.store.update(followup,{status:'pending',draft:'A new draft.',reply_decision:'REPLY',manual_hold:0,review:0});s.workflow.lastPublish=0;
  await assert.rejects(s.workflow.publish(followup,undefined,true),/needs your approval/);
  assert.equal(s.posted(),0);assert.equal(s.store.get(followup).is_followup,1);assert.equal(s.store.get(followup).status,'pending');
});
