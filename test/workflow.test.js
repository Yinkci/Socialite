import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { openStore } from './helpers.js';
import { Facebook, validSignature } from '../src/facebook.js';
import { Workflow } from '../src/workflow.js';
import { buildPrompt } from '../src/prompt.js';
import { WINE_AND_SILENCE_PERSONALITY } from '../src/personality-presets.js';

test('Wine and Silence regeneration uses the full supplied personality for this draft and stays held',async t=>{
  const s=setup(t);add(s.store,'preset','test');
  s.store.saveSettings({...s.store.settings(),personality:'My saved personality',knowledge:'Approved facts',mode:'automatic'});
  s.store.update('preset',{status:'pending',draft:'The old reply.'});let received;
  s.ai.generate=async(settings,c)=>{received={settings,c};return {reply:'Some memories stay with us even as places change. 🤍',reply_decision:'REPLY',needs_review:false};};
  await s.workflow.generate('preset','My edited draft.',undefined,'improve',true,'wine-and-silence');
  assert.equal(received.settings.personality,WINE_AND_SILENCE_PERSONALITY);assert.equal(received.settings.knowledge,'Approved facts');
  assert.equal(received.c.personalityPreset,'wine-and-silence');assert.ok(received.c.previousReplies.includes('My edited draft.'));
  const prompt=buildPrompt(received.settings,received.c).instructions;
  assert.match(prompt,/“It did make me stronger.”/);assert.match(prompt,/at most one emoji/);assert.match(prompt,/take precedence over conflicting generic tone examples/);
  assert.equal(s.store.settings().personality,'My saved personality');assert.equal(s.store.get('preset').status,'pending');assert.equal(s.store.get('preset').manual_hold,1);assert.equal(s.store.get('preset').review,1);
  await s.workflow.tick();assert.equal(s.posted(),0);
});

test('unknown or automatic personality requests are rejected before claiming the comment',async t=>{
  const s=setup(t);add(s.store);let calls=0;s.ai.generate=async()=>{calls++;};
  await assert.rejects(s.workflow.generate('comment-1',undefined,undefined,'improve',true,'unknown'),/Unknown reply personality/);
  await assert.rejects(s.workflow.generate('comment-1',undefined,undefined,'improve',false,'wine-and-silence'),/manual reply generation/);
  assert.equal(s.store.get('comment-1').status,'queued');assert.equal(calls,0);
});

test('automatic agreement stays skipped but an explicit manual request produces a held draft',async t=>{
  for(const source of ['test','facebook']){
    const s=setup(t);add(s.store,'agreement',source);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
    s.store.update('agreement',{message:'Yeah, TRUTH! ❤️ 😳 🔥',context:'Some Places Will Never Feel the Same Again.'});
    s.facebook.current=async()=>({message:'Yeah, TRUTH! ❤️ 😳 🔥'});
    let received;
    s.ai.generate=async(settings,c)=>{received=c;return c.manualRequest?{reply_decision:'REPLY',reply:'Some places hold memories that stay with us.',needs_review:false}:{reply_decision:'SKIP',reply:'',reason:'Simple agreement with the post.',needs_review:true};};
    await s.workflow.tick();assert.equal(s.store.get('agreement').status,'skipped');
    assert.equal(received.manualRequest,false,'automatic classification is unchanged');
    const result=await s.workflow.generate('agreement',undefined,'agree','improve',true);
    assert.equal(result.ok,true);assert.equal(received.manualRequest,true);assert.equal(received.ownerInstructions,'agree');
    const draft=s.store.get('agreement');assert.equal(draft.status,'pending');assert.equal(draft.manual_hold,1);assert.equal(draft.review,1);
    assert.match(buildPrompt(s.store.settings(),received).instructions,/Manual owner request/);
    await s.workflow.tick();assert.equal(s.posted(),0,'manually requested draft never auto-publishes');
  }
});

test('manual Generate reply bypasses automatic emoji skipping without requiring owner text',async t=>{
  const s=setup(t);add(s.store,'emoji','test');s.store.saveSettings({...s.store.settings(),skipEmojiOnly:true,replyPolicyPageId:'123'});
  s.store.update('emoji',{message:'❤️',status:'skipped',reply_decision:'SKIP'});let received;
  s.ai.generate=async(settings,c)=>{received=c;return {reply_decision:'REPLY',reply:'Glad this resonated with you.',needs_review:false};};
  await s.workflow.generate('emoji',undefined,undefined,'improve',true);
  assert.equal(received.manualRequest,true);assert.equal(s.store.get('emoji').status,'pending');assert.equal(s.store.get('emoji').manual_hold,1);
});

function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'page-studio-test-')), store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveSettings({...store.settings(),live:true,pageId:'123',graphVersion:'v24.0',model:'test-model'});
  const vault={value:{facebookToken:'test-token',hostId:'test-host'},get(k){return this.value[k];},set(k,v){this.value[k]=v;}};
  const facebook=new Facebook(store,vault);let posted=0;
  facebook.verify=async()=>({id:'123'});
  facebook.current=async c=>({message:c.message});facebook.context=async()=> 'Our new product';
  facebook.post=async()=>({caption:'Our new product',url:'https://www.facebook.com/post-1',image:'https://scontent.fbcdn.net/p.jpg'});
  facebook.publish=async()=>{posted++;return {id:'reply-1'};};facebook.like=async()=>{};
  const ai={status:()=>({enabled:true}),generate:async()=>({reply_decision:'REPLY',reply:'Thanks for sharing!',needs_review:false,reason:''})};
  const workflow=new Workflow(store,ai,facebook);
  return {store,vault,facebook,ai,workflow,posted:()=>posted};
}
function add(store,id='comment-1',source='facebook') {store.add({id,post_id:'123_456',message:'Love it!',author:'Alex',context:'New launch',source});}
function payload(value,entry='123') {return {object:'page',entry:[{id:entry,changes:[{field:'feed',value:{item:'comment',verb:'add',comment_id:'comment-1',post_id:'123_456',parent_id:'123_456',message:'Hello',from:{id:'999',name:'Alex'},...value}}]}]};}

test('all single-word comments skip before AI in every mode, with emojis excluded from the count',async t=>{
  for(const mode of ['approval','hybrid','automatic'])for(const source of ['facebook','test']){
    const s=setup(t);s.store.saveSettings({...s.store.settings(),mode,skipEmojiOnly:false});let calls=0,likes=0;
    s.ai.generate=async()=>{calls++;return {reply:'A long enough reply.',reply_decision:'REPLY',needs_review:false};};s.facebook.like=async()=>likes++;
    for(const [i,message] of ['Amen 😳','Beautiful','Thanks👍🏽','1️⃣ Amen 2️⃣','🙏 Agree ❤️'].entries()){
      const id='single-'+i;add(s.store,id,source);s.store.update(id,{message});
    }
    await s.workflow.tick();
    for(const c of s.store.list()){assert.equal(c.status,'skipped');assert.equal(c.reply_decision,'SKIP');assert.equal(c.draft,'');assert.match(c.reason,/Single-word comment/);}
    assert.equal(calls,0);assert.equal(likes,0);assert.equal(s.posted(),0);
  }
});

test('single-word pending drafts cannot automatically publish; manual restoration remains held',async t=>{
  const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic'});add(s.store);
  s.store.update('comment-1',{message:'Amen 😳',status:'pending',draft:'A previously generated full reply.',reply_decision:'REPLY',review:0,manual_hold:0});
  await s.workflow.publish('comment-1',undefined,true);assert.equal(s.store.get('comment-1').status,'skipped');assert.equal(s.posted(),0);
  await s.workflow.generate('comment-1',undefined,undefined,'improve',true);
  assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.store.get('comment-1').manual_hold,1);
  await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.posted(),0);
});

test('single-word policy preserves published history, follow-up approval and other Pages',async t=>{
  const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
  for(const id of ['sent','followup','foreign','two-words'])add(s.store,id);
  s.store.update('sent',{message:'Amen 😳',status:'published',draft:'Already sent.',reply_id:'sent-reply'});
  s.store.update('followup',{message:'Thanks 🙏',is_followup:1,manual_hold:1,status:'pending',review:1,draft:'An owner-held reply.'});
  s.store.update('foreign',{message:'Amen'});s.store.db.prepare("UPDATE comments SET page_id='456' WHERE id='foreign'").run();
  s.store.update('two-words',{message:'Thank you 🙏'});
  s.workflow.applyReplyPolicy();
  assert.equal(s.store.get('sent').status,'published');assert.equal(s.store.get('sent').reply_id,'sent-reply');
  assert.equal(s.store.get('followup').status,'pending');assert.equal(s.store.get('followup').manual_hold,1);
  assert.equal(s.store.get('foreign').status,'queued');assert.equal(s.store.get('two-words').status,'queued');
});

test('a skipped single-word comment stays skipped after an edit requeues it',async t=>{
  const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic'});let calls=0;
  s.ai.generate=async()=>{calls++;return {reply:'A full generated reply.',reply_decision:'REPLY',needs_review:false};};
  s.facebook.ingest(payload({message:'Amen 😳'}));await s.workflow.tick();
  assert.equal(s.store.get('comment-1').status,'skipped');assert.equal(s.store.get('comment-1').manual_hold,1);
  s.facebook.ingest(payload({verb:'edited',message:'Exactly 🙏'}));
  assert.equal(s.store.get('comment-1').status,'queued');await s.workflow.tick();
  assert.equal(s.store.get('comment-1').status,'skipped');assert.equal(calls,0);assert.equal(s.posted(),0);
});

test('24h activity retains received, approval, publication and attention timestamps after status changes',t=>{
  const {store}=setup(t),now=Date.now();
  add(store,'handled');
  store.update('handled',{status:'pending'});
  store.update('handled',{status:'published',published_at:now});
  add(store,'issue');
  store.update('issue',{status:'error'});
  store.update('issue',{status:'queued'});
  add(store,'like-issue');
  store.update('like-issue',{status:'published',published_at:now,publish_kind:'automatic'});
  store.update('like-issue',{reaction_status:'error',reaction_error:'Like failed'});
  add(store,'sample','test');
  const times=store.kpiTimes(now-86400e3);
  assert.equal(times.new.length,3);
  assert.equal(times.pending.length,1);
  assert.equal(times.published.length,2);
  assert.equal(times.automatic.length,1);
  assert.equal(store.tabCounts().error,1);
  assert.equal(store.list().find(c=>c.id==='handled').status,'published');
  assert.equal(store.list().find(c=>c.id==='issue').status,'queued');
});
test('24h received count includes comments beyond the 300-row inbox limit',t=>{
  const {store}=setup(t);
  for(let i=0;i<301;i++)add(store,'recent-'+i);
  assert.equal(store.list().length,300);
  assert.equal(store.kpiTimes().new.length,301);
});

test('webhook rejects invalid signatures and verifies exact raw bytes',()=>{
  const raw=Buffer.from('{"test":1}'), secret='test-secret';
  const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  assert.equal(validSignature(raw,sig,secret),true);
  assert.equal(validSignature(Buffer.from('{"test":2}'),sig,secret),false);
  assert.equal(validSignature(raw,undefined,secret),false);
  assert.equal(validSignature(raw,sig,''),false);
});
test('deduplicates webhook retries and skips own comments, threads, and other Pages',t=>{
  const {store,facebook}=setup(t);
  assert.equal(facebook.ingest(payload({})),1);assert.equal(facebook.ingest(payload({})),0);
  assert.equal(facebook.ingest(payload({comment_id:'own',from:{id:'123'}})),0);
  assert.equal(facebook.ingest(payload({comment_id:'thread',parent_id:'comment-1'})),0);
  assert.equal(facebook.ingest(payload({comment_id:'other'},'456')),0);assert.equal(store.list().length,1);
});
test('accepts top-level photo comments whose parent_id uses a different prefix, still skips replies',t=>{
  const {store,facebook}=setup(t);
  assert.equal(facebook.ingest(payload({comment_id:'photo-top',parent_id:'888_456'})),1);
  assert.equal(facebook.ingest(payload({comment_id:'photo-reply',parent_id:'456_777'})),0);
  assert.equal(store.list().length,1);
});
test('post allowlist excludes unrelated comments',t=>{const {store,facebook}=setup(t);store.saveSettings({...store.settings(),postIds:'123_789'});assert.equal(facebook.ingest(payload({})),0);});
test('approval mode drafts but never publishes automatically',async t=>{const s=setup(t);add(s.store);await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.posted(),0);});

test('regeneration sends previous drafts to AI and retries a repeated reply once',async t=>{
  const s=setup(t);add(s.store);await s.workflow.generate('comment-1');let attempts=[];
  s.ai.generate=async(settings,c)=>{attempts.push(c);return {reply_decision:'REPLY',reply:attempts.length===1?'THANKS FOR SHARING!!!':'So glad this resonated with you.',needs_review:false,reason:''};};
  const result=await s.workflow.generate('comment-1','My edited version');
  assert.equal(result.ok,true);assert.equal(attempts.length,2);assert.ok(attempts[0].previousReplies.includes('Thanks for sharing!'));assert.ok(attempts[0].previousReplies.includes('My edited version'));assert.equal(attempts[1].regenerationAttempt,2);
  assert.equal(s.store.get('comment-1').draft,'So glad this resonated with you.');assert.equal(s.posted(),0);
});

test('repeated regeneration keeps the existing draft and reports failure without making it auto-publishable',async t=>{
  const s=setup(t);add(s.store);await s.workflow.generate('comment-1');let attempts=0;s.ai.generate=async()=>{attempts++;return {reply_decision:'REPLY',reply:'Thanks for sharing! 😀',needs_review:false,reason:''};};
  const result=await s.workflow.generate('comment-1');assert.equal(result.ok,false);assert.equal(attempts,2);assert.match(result.error,/repeated/);
  assert.equal(s.store.get('comment-1').draft,'Thanks for sharing!');assert.equal(s.store.get('comment-1').status,'pending');
  s.store.saveSettings({...s.store.settings(),mode:'automatic'});await s.workflow.tick();assert.equal(s.posted(),0);
});

test('regeneration avoids other recent alternatives, not just the immediately previous reply',async t=>{
  const s=setup(t);add(s.store);await s.workflow.generate('comment-1');s.ai.generate=async()=>({reply_decision:'REPLY',reply:'Happy you enjoyed it.',needs_review:false,reason:''});await s.workflow.generate('comment-1');
  let attempt=0;s.ai.generate=async()=>({reply_decision:'REPLY',reply:++attempt===1?'Thanks for sharing!':'Appreciate you being here.',needs_review:false,reason:''});await s.workflow.generate('comment-1');
  assert.equal(attempt,2);assert.equal(s.store.get('comment-1').draft,'Appreciate you being here.');
});

test('dismissed replies stay inactive until explicitly regenerated and restored drafts always require approval',async t=>{
  for(const mode of ['approval','hybrid','automatic']){
    const s=setup(t);add(s.store);await s.workflow.generate('comment-1');
    s.store.update('comment-1',{status:'rejected'});s.store.saveSettings({...s.store.settings(),mode});
    await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'rejected');assert.equal(s.posted(),0);
    s.ai.generate=async()=>({reply_decision:'REPLY',reply:'A new reply after dismissal.',needs_review:false,reason:''});
    await s.workflow.generate('comment-1');await s.workflow.tick();
    assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.store.get('comment-1').manual_hold,1);assert.equal(s.store.get('comment-1').draft,'A new reply after dismissal.');assert.equal(s.posted(),0);
    s.ai.generate=async()=>({reply_decision:'REPLY',reply:'Another fresh alternative.',needs_review:false,reason:''});
    await s.workflow.generate('comment-1');await s.workflow.tick();assert.equal(s.posted(),0);
    await s.workflow.publish('comment-1');assert.equal(s.posted(),1);
  }
});

test('dismissed comments cannot be restored against a different Page',async t=>{
  const s=setup(t);add(s.store);s.store.update('comment-1',{status:'rejected'});s.store.saveSettings({...s.store.settings(),pageId:'456'});
  await assert.rejects(s.workflow.generate('comment-1'),/different Page/);assert.equal(s.store.get('comment-1').status,'rejected');assert.equal(s.posted(),0);
});

test('Facebook edits do not automatically reactivate a dismissed reply',async t=>{
  const s=setup(t);s.facebook.ingest(payload({}));await s.workflow.generate('comment-1');s.store.update('comment-1',{status:'rejected',manual_hold:1});
  s.facebook.ingest(payload({verb:'edited',message:'Updated comment'}));await s.workflow.tick();
  assert.equal(s.store.get('comment-1').status,'rejected');assert.equal(s.store.get('comment-1').message,'Updated comment');assert.equal(s.store.get('comment-1').draft,'');assert.equal(s.posted(),0);
});

test('removed and already-published comments remain protected from regeneration',async t=>{
  const s=setup(t);add(s.store);
  for(const status of ['removed','published','publishing','uncertain']){s.store.update('comment-1',{status});await assert.rejects(s.workflow.generate('comment-1'),/cannot be regenerated/);assert.equal(s.store.get('comment-1').status,status);}
});
test('manual approval sends directly in every mode, including with a legacy pause flag',async t=>{
  for(const mode of ['approval','hybrid','automatic']){
    const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode,paused:true});
    await s.workflow.generate('comment-1');await s.workflow.publish('comment-1');
    assert.equal(s.posted(),1);assert.equal(s.store.get('comment-1').status,'published');assert.equal('paused' in s.store.settings(),false);
  }
});

test('publishing mode controls sending while every mode drafts eligible multi-word comments',async t=>{
  for(const mode of ['approval','hybrid','automatic']) {
    const s=setup(t);s.store.saveSettings({...s.store.settings(),mode,paused:true});
    assert.equal(s.facebook.ingest(payload({message:'Love it!'})),1);await s.workflow.tick();
    assert.equal(s.store.get('comment-1').draft,'Thanks for sharing!');
    assert.equal(s.store.get('comment-1').status,mode==='approval'?'pending':'published');
    assert.equal(s.posted(),mode==='approval'?0:1);
  }
});

test('switching to approval during automatic verification stops the pending automatic send',async t=>{
  const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
  s.facebook.verify=async()=>s.store.saveSettings({...s.store.settings(),mode:'approval'});
  await s.workflow.tick();assert.equal(s.posted(),0);assert.equal(s.store.get('comment-1').status,'pending');
  await s.workflow.publish('comment-1');assert.equal(s.posted(),1);
});

test('approval mode drains new comments into drafts without replacing edits or publishing',async t=>{
  const s=setup(t);add(s.store,'first');add(s.store,'second');
  await s.workflow.tick();
  s.store.update('first',{draft:'My edited reply'});
  await s.workflow.tick();await s.workflow.tick();
  assert.equal(s.store.get('first').draft,'My edited reply');
  assert.equal(s.store.get('second').status,'pending');
  assert.equal(s.posted(),0);
  s.ai.generate=async()=>({reply_decision:'REPLY',reply:'A regenerated reply.',needs_review:false,reason:''});
  await s.workflow.generate('second');
  assert.equal(s.store.get('second').draft,'A regenerated reply.');
  assert.equal(s.store.get('second').status,'pending');
  assert.equal(s.posted(),0);
});

test('disconnected AI leaves new comments queued until reconnected',async t=>{
  const s=setup(t);add(s.store);s.ai.status=()=>({enabled:false});
  await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'queued');
  s.ai.status=()=>({enabled:true});await s.workflow.tick();
  assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.posted(),0);
});
test('test comment approval never invokes Facebook',async t=>{const s=setup(t);add(s.store,'test-1','test');await s.workflow.generate('test-1');await s.workflow.publish('test-1');assert.equal(s.store.get('test-1').status,'simulated');assert.equal(s.posted(),0);});
test('hybrid holds uncertain drafts',async t=>{const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'hybrid'});s.ai.generate=async()=>({reply_decision:'REPLY',reply:'Please contact us.',needs_review:true,reason:'Need details'});await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.posted(),0);});

test('grief and possible danger drafts require personal approval even in automatic mode',async t=>{
  for(const context of ['GRIEF','POSSIBLE_DANGER']){
    const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
    s.ai.generate=async()=>({reply_decision:'REPLY',reply:'I am so sorry for your loss. Sending you love.',needs_review:true,reason:'Sensitive comment: please review personally.',reaction:'CARE',sensitive_context:context});
    await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.store.get('comment-1').manual_hold,1);assert.equal(s.store.get('comment-1').reaction_choice,'LIKE');assert.equal(s.posted(),0);
  }
});

test('hybrid sends routine replies and double approvals cannot duplicate',async t=>{const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'hybrid'});await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'published');await assert.rejects(s.workflow.publish('comment-1'));assert.equal(s.posted(),1);});
test('changed comment invalidates draft before posting',async t=>{const s=setup(t);add(s.store);await s.workflow.generate('comment-1');s.facebook.current=async()=>({message:'Actually I need help'});await s.workflow.publish('comment-1');assert.equal(s.store.get('comment-1').status,'queued');assert.equal(s.store.get('comment-1').draft,'');assert.equal(s.posted(),0);});
test('edited and removed comments discard pending drafts',async t=>{const s=setup(t);s.facebook.ingest(payload({}));await s.workflow.generate('comment-1');s.facebook.ingest(payload({verb:'edited',message:'Changed'}));assert.equal(s.store.get('comment-1').draft,'');assert.equal(s.store.get('comment-1').status,'queued');s.facebook.ingest(payload({verb:'remove'}));assert.equal(s.store.get('comment-1').status,'removed');});
test('unknown publish outcomes are never automatically retried',async t=>{const s=setup(t);add(s.store);await s.workflow.generate('comment-1');s.facebook.publish=async()=>{throw new Error('network timeout');};await assert.rejects(s.workflow.publish('comment-1'));assert.equal(s.store.get('comment-1').status,'uncertain');await assert.rejects(s.workflow.publish('comment-1'));});
test('definite posting errors wait for manual retry',async t=>{const s=setup(t);add(s.store);await s.workflow.generate('comment-1');s.facebook.publish=async()=>{const e=new Error('Permission denied');e.definite=true;throw e;};await assert.rejects(s.workflow.publish('comment-1'));s.store.saveSettings({...s.store.settings(),mode:'automatic'});await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'pending');assert.match(s.store.get('comment-1').error,/Permission/);});
test('only one publication can run at a time',async t=>{const s=setup(t);add(s.store,'one');add(s.store,'two');await s.workflow.generate('one');await s.workflow.generate('two');let release,first=true;s.facebook.verify=()=>first?(first=false,new Promise(r=>{release=r;})):Promise.resolve();const publishing=s.workflow.publish('one');await assert.rejects(s.workflow.publish('two'),/Another reply/);release();await publishing;assert.equal(s.posted(),1);});
test('recovery marks interrupted publications uncertain',t=>{const dir=mkdtempSync(join(tmpdir(),'studio-recovery-'));let store=openStore(dir);add(store);store.update('comment-1',{status:'publishing'});store.close();store=openStore(dir);assert.equal(store.get('comment-1').status,'uncertain');store.close();rmSync(dir,{recursive:true,force:true});});
test('loads the commented post preview in approval mode',async t=>{
  const {store,workflow}=setup(t);store.saveSettings({...store.settings(),mode:'approval'});
  store.add({id:'c1',post_id:'123_456',message:'Nice post',author:'Alex',source:'facebook'});
  await workflow.tick();
  const c=store.get('c1');
  assert.equal(c.post_loaded,1);assert.equal(c.post_url,'https://www.facebook.com/post-1');assert.equal(c.post_image,'https://scontent.fbcdn.net/p.jpg');assert.equal(c.context,'Our new product');
});

test('single-word skips still get shared post previews without AI, publishing or Likes',async t=>{
  const s=setup(t);let fetches=0,ai=0,likes=0;
  s.facebook.post=async()=>{fetches++;return {caption:'Some memories stay.',url:'https://www.facebook.com/post',image:'https://example.com/post.jpg'};};
  s.ai.generate=async()=>{ai++;};s.facebook.like=async()=>{likes++;};
  for(const id of ['one','two'])s.store.add({id,post_id:'123_456',message:'Amen',source:'facebook'});
  await s.workflow.tick();
  for(const id of ['one','two']){const c=s.store.get(id);assert.equal(c.status,'skipped');assert.equal(c.post_loaded,1);assert.equal(c.context,'Some memories stay.');assert.equal(c.post_image,'https://example.com/post.jpg');assert.equal(c.draft,'');}
  assert.equal(fetches,1);assert.equal(ai,0);assert.equal(likes,0);assert.equal(s.posted(),0);
  await s.workflow.tick();assert.equal(fetches,1);
});

test('existing no-reply history reuses a saved post and does not touch cleared or other-Page comments',async t=>{
  const s=setup(t);let fetches=0;s.facebook.post=async()=>{fetches++;throw Error('Should use saved preview');};
  add(s.store,'saved');s.store.update('saved',{status:'published',context:'Saved caption',post_image:'https://example.com/saved.jpg',post_loaded:1});
  for(const id of ['skipped','cleared','other']){add(s.store,id);s.store.update(id,{status:'skipped',context:'',draft:'',reply_decision:'SKIP',manual_hold:1});}
  s.store.db.prepare("UPDATE comments SET cleared_at=? WHERE id='cleared'").run(Date.now());
  s.store.db.prepare("UPDATE comments SET page_id='other-page' WHERE id='other'").run();
  await s.workflow.loadPost();
  const c=s.store.get('skipped');assert.equal(c.context,'Saved caption');assert.equal(c.post_loaded,1);assert.equal(c.status,'skipped');assert.equal(c.reply_decision,'SKIP');assert.equal(c.manual_hold,1);
  assert.equal(s.store.get('cleared').post_loaded,0);assert.equal(s.store.get('other').post_loaded,0);assert.equal(fetches,0);
});


test('owner-guided drafting forwards the idea and current reply and prevents automatic publishing',async t=>{
  const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
  let received;s.ai.generate=async(settings,c)=>{received=c;return {reply_decision:'REPLY',reply:'Your encouragement means a lot to us.',needs_review:false,reason:''};};
  await s.workflow.generate('comment-1','Thanks so much','Make my thanks sound more personal.');
  assert.equal(received.ownerInstructions,'Make my thanks sound more personal.');assert.equal(received.currentReply,'Thanks so much');
  assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.store.get('comment-1').manual_hold,1);
  await s.workflow.tick();assert.equal(s.posted(),0);
});

test('invalid owner instructions do not claim the comment or call AI',async t=>{
  const s=setup(t);add(s.store);let called=false;s.ai.generate=async()=>{called=true;};
  for(const instructions of [123,'x'.repeat(2001)])await assert.rejects(s.workflow.generate('comment-1',undefined,instructions),/2000 characters/);
  assert.equal(called,false);assert.equal(s.store.get('comment-1').status,'queued');
});


test('Facebook verification remembers the matching Page name and rejects a different Page identity',async t=>{
  const s=setup(t);let page={id:'123',name:'Our Community'};
  const fb=new Facebook(s.store,s.vault,async()=>new Response(JSON.stringify(page)));
  await fb.verify();assert.deepEqual(s.store.settings().facebookPage,page);
  page={id:'999',name:'Wrong Page'};await assert.rejects(fb.verify(),/different Page/);
  assert.equal(s.store.settings().facebookPage.name,'Our Community');
});


test('only confirmed Facebook publications teach memory; final owner edits receive stronger provenance',async t=>{
  const s=setup(t);add(s.store);await s.workflow.generate('comment-1');
  assert.equal(s.workflow.memory.status().total,0);
  await s.workflow.publish('comment-1','Your encouragement means so much.');
  assert.equal(s.workflow.memory.status().counts.edited,1);
  assert.equal(s.workflow.memory.list().rows[0].reply,'Your encouragement means so much.');
  add(s.store,'test','test');await s.workflow.generate('test');await s.workflow.publish('test');
  assert.equal(s.workflow.memory.status().total,1);
  add(s.store,'uncertain');await s.workflow.generate('uncertain');s.workflow.lastPublish=0;
  s.facebook.publish=async()=>{throw new Error('Connection interrupted');};
  await assert.rejects(s.workflow.publish('uncertain'));assert.equal(s.workflow.memory.status().total,1);
});

test('drafting receives published style memory while personality and current settings remain intact',async t=>{
  const s=setup(t);add(s.store);await s.workflow.generate('comment-1');await s.workflow.publish('comment-1');
  add(s.store,'next');let received;s.ai.generate=async(settings,c)=>{received={settings,c};return {reply_decision:'REPLY',reply:'Grateful for your kind words.',needs_review:false};};
  await s.workflow.generate('next');assert.equal(received.c.replyMemory.examples.length,1);
  assert.equal(received.c.replyMemory.examples[0].source,'approved');assert.equal(received.settings.personality,s.store.settings().personality);
  s.store.saveSettings({...s.store.settings(),learningEnabled:false});await s.workflow.generate('next');assert.equal(received.c.replyMemory,null);
});

test('a failure saving memory never makes a confirmed publication uncertain',async t=>{
  const s=setup(t);add(s.store);await s.workflow.generate('comment-1');s.workflow.memory.capture=()=>{throw new Error('Memory unavailable');};
  await s.workflow.publish('comment-1');assert.equal(s.store.get('comment-1').status,'published');assert.equal(s.posted(),1);
});


test('Page follower refresh stores exact count and timestamp, and ordinary verification preserves them',async t=>{
  const s=setup(t);let fields;
  const fb=new Facebook(s.store,s.vault,async url=>{fields=new URL(url).searchParams.get('fields');return new Response(JSON.stringify({id:'123',name:'Our Community',...(fields.includes('followers_count')?{followers_count:7045}:{})}));});
  await fb.verify(true);assert.equal(fields,'id,name,followers_count');const p=s.store.settings().facebookPage;
  assert.equal(p.followersCount,7045);assert.ok(p.followersUpdatedAt>0);
  await fb.verify();assert.equal(s.store.settings().facebookPage.followersCount,7045);assert.equal(s.store.settings().facebookPage.followersUpdatedAt,p.followersUpdatedAt);
});


test('grammar-only allows unchanged text without retries, bypasses memory, and holds for approval',async t=>{
  const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
  s.store.update('comment-1',{status:'pending',draft:'Thank you for your support.',reaction_choice:'CARE'});
  s.workflow.memory.forDraft=()=>{throw new Error('Grammar editing must not access style memory');};
  let received,calls=0;s.ai.generate=async(settings,c)=>{received=c;calls++;return {reply_decision:'REPLY',reply:c.ownerInstructions,needs_review:false,reaction:'NONE'};};
  await s.workflow.generate('comment-1','Thank you for your support.','Thank you for your support.','grammar');
  assert.equal(calls,1);assert.equal(received.grammarOnly,true);assert.equal(received.replyMemory,null);assert.deepEqual(received.previousReplies,[]);
  assert.equal(s.store.get('comment-1').draft,'Thank you for your support.');assert.equal(s.store.get('comment-1').manual_hold,1);
  assert.equal(s.store.get('comment-1').reaction_choice,'LIKE');await s.workflow.tick();assert.equal(s.posted(),0);
});

test('grammar editing validates the operation and source before claiming a draft',async t=>{
  const s=setup(t);add(s.store);
  await assert.rejects(s.workflow.generate('comment-1',undefined,'Text','invalid'),/Choose Improve/);
  for(const text of ['', 'x'.repeat(1001)])await assert.rejects(s.workflow.generate('comment-1',undefined,text,'grammar'),/1-1000/);
  assert.equal(s.store.get('comment-1').status,'queued');
});

test('no-reply decisions never publish, clear obsolete drafts, and do not retry or teach memory',async t=>{
  for(const mode of ['approval','hybrid','automatic']){
    const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode});
    s.store.update('comment-1',{draft:'An obsolete reply',reaction_choice:'LIKE'});let calls=0;
    s.ai.generate=async()=>{calls++;return {reply_decision:'SKIP',reply:'Ignore this stray model draft',needs_review:true,reason:'Random keyboard text.',reaction:'NONE'};};
    await s.workflow.tick();const c=s.store.get('comment-1');assert.equal(c.status,'skipped');assert.equal(c.draft,'');assert.equal(c.reaction_choice,'NONE');
    await s.workflow.tick();await s.workflow.tick();assert.equal(calls,1);assert.equal(s.posted(),0);assert.equal(s.workflow.memory.status().total,0);
    await assert.rejects(s.workflow.publish('comment-1'),/Only pending/);
    s.ai.generate=async()=>({reply_decision:'REPLY',reply:'Thanks for explaining what you meant.',needs_review:false});
    await s.workflow.generate('comment-1');await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'pending');assert.equal(s.posted(),0);
  }
});

test('ambiguous and unclassified comments require approval even in automatic mode',async t=>{
  for(const decision of ['REVIEW',undefined]){
    const s=setup(t);add(s.store);s.store.saveSettings({...s.store.settings(),mode:'automatic'});
    s.ai.generate=async()=>({reply_decision:decision,reply:'Could you clarify what you mean?',needs_review:false,reason:'Meaning is unclear.'});
    await s.workflow.tick();assert.equal(s.posted(),0);assert.equal(s.store.get('comment-1').manual_hold,1);assert.equal(s.store.get('comment-1').reply_decision,'REVIEW');
    await s.workflow.publish('comment-1');assert.equal(s.posted(),1);
  }
});

test('unclassified legacy pending replies are excluded from the automatic publishing queue',async t=>{
  const s=setup(t);add(s.store);s.store.update('comment-1',{status:'pending',draft:'Legacy draft',review:0});
  s.store.saveSettings({...s.store.settings(),mode:'automatic'});await s.workflow.tick();assert.equal(s.posted(),0);
  await s.workflow.generate('comment-1');await s.workflow.tick();assert.equal(s.posted(),1);
});

test('Page-specific emoji-only policy skips existing and incoming comments without AI or publication',async t=>{
  const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic',skipEmojiOnly:true,replyPolicyPageId:'123'});
  let calls=0;s.ai.generate=async()=>{calls++;throw new Error('Emoji-only comments must not call AI');};
  for(const [id,message,status] of [['fire','\u{1F525} \u{1F525} \u{1F525}','pending'],['smile','\u{1F601}','queued']]){
    add(s.store,id);s.store.update(id,{message,status,draft:status==='pending'?'Appreciate you!':'',reply_decision:'REPLY'});
  }
  await s.workflow.tick();assert.equal(calls,0);assert.equal(s.posted(),0);
  for(const id of ['fire','smile']){assert.equal(s.store.get(id).status,'skipped');assert.equal(s.store.get(id).draft,'');}
});

test('emoji-only rule is Page scoped and leaves written reflections eligible',async t=>{
  const s=setup(t);s.store.saveSettings({...s.store.settings(),skipEmojiOnly:true,replyPolicyPageId:'123'});
  add(s.store);s.store.update('comment-1',{message:'I needed this reminder today. Keep going! \u{1F64F}'});
  await s.workflow.generate('comment-1');assert.equal(s.store.get('comment-1').status,'pending');
  s.store.saveSettings({...s.store.settings(),replyPolicyPageId:'999'});add(s.store,'emoji');s.store.update('emoji',{message:'\u{1F525}'});
  await s.workflow.generate('emoji');assert.equal(s.store.get('emoji').status,'pending');
});


test('publication history records the actual send method and timestamp independently of learning and mode',async t=>{
  const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic',learningEnabled:false});
  for(const [id,edited,automatic,kind] of [['owner',undefined,false,'approved'],['edited','My own wording.',false,'edited'],['auto',undefined,true,'automatic']]){
    add(s.store,id);await s.workflow.generate(id);s.workflow.lastPublish=0;
    const before=Date.now();await s.workflow.publish(id,edited,automatic);
    const row=s.store.get(id);assert.equal(row.status,'published');assert.equal(row.publish_kind,kind);assert.ok(row.published_at>=before);
    const sentAt=row.published_at;s.store.update(id,{reaction_choice:'CARE'});assert.equal(s.store.get(id).published_at,sentAt);
  }
  assert.equal(s.workflow.memory.status().total,0);
  add(s.store,'failed');await s.workflow.generate('failed');s.workflow.lastPublish=0;
  s.facebook.publish=async()=>{throw new Error('Connection interrupted');};
  await assert.rejects(s.workflow.publish('failed',undefined,true));assert.equal(s.store.get('failed').status,'uncertain');assert.equal(s.store.get('failed').published_at,0);
});


test('legacy publication dates are recovered only from matching confirmed memory',t=>{
  const dir=mkdtempSync(join(tmpdir(),'socialite-publication-test-'));let store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.db.exec("CREATE TABLE reply_memory (comment_id TEXT PRIMARY KEY,kind TEXT,reply TEXT,published_at INTEGER)");
  for(const [id,kind,rememberedKind,text] of [['known','approved','approved','Thanks!'],['unknown','','historical','Thanks!'],['mismatch','automatic','approved','Thanks!'],['changed','edited','edited','Other wording']]){
    store.add({id,source:'facebook',message:'Hello'});store.update(id,{status:'published',publish_kind:kind,draft:'Thanks!'});
    store.db.prepare('INSERT INTO reply_memory VALUES(?,?,?,?)').run(id,rememberedKind,text,123456);
  }
  store.close();store=openStore(dir);
  assert.equal(store.get('known').published_at,123456);
  for(const id of ['unknown','mismatch','changed'])assert.equal(store.get(id).published_at,0);
});


test('clearing history is category and Page scoped, excludes active rows, and keeps webhook deduplication',async t=>{
  const s=setup(t);
  for(const [id,status] of [['skip','skipped'],['dismiss','rejected'],['pending','pending'],['published','published'],['other','skipped']]){add(s.store,id);s.store.update(id,{status});}
  s.store.db.prepare("UPDATE comments SET page_id='456' WHERE id='other'").run();
  assert.throws(()=>s.store.clearHistory('published'),/Only/);
  s.store.update('skip',{reaction_status:'applying'});assert.throws(()=>s.store.clearHistory('skipped'),/reaction/);assert.equal(s.store.get('skip').cleared_at,0);
  s.store.update('skip',{reaction_status:'pending'});assert.equal(s.store.clearHistory('skipped'),1);
  assert.equal(s.store.get('skip').status,'skipped');assert.ok(s.store.get('skip').cleared_at);assert.equal(s.store.list().some(c=>c.id==='skip'),false);
  assert.deepEqual(s.store.clearableCounts(),{skipped:0,rejected:1});assert.equal(s.store.clearHistory('skipped'),0);
  assert.equal(s.facebook.ingest(payload({comment_id:'skip'})),0);s.facebook.ingest(payload({comment_id:'skip',verb:'edited',message:'A new message'}));assert.equal(s.store.get('skip').status,'skipped');
  await assert.rejects(s.workflow.generate('skip'),/cleared/);
  assert.equal(s.store.clearHistory('rejected'),1);assert.equal(s.store.get('pending').cleared_at,0);assert.equal(s.store.get('published').cleared_at,0);assert.equal(s.store.get('other').cleared_at,0);
});

test('clearing includes archived entries beyond the list limit and persists across restarts',t=>{
  const dir=mkdtempSync(join(tmpdir(),'socialite-clear-test-'));let store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<305;i++){store.add({id:'c'+i,message:'Hello',source:'test'});store.update('c'+i,{status:'skipped'});}
  assert.equal(store.list().length,300);assert.equal(store.tabCounts().skipped,305);assert.equal(store.clearableCounts().skipped,305);assert.equal(store.clearHistory('skipped'),305);
  store.close();store=openStore(dir);assert.equal(store.list().length,0);assert.equal(store.add({id:'c0',message:'Hello',source:'test'}),false);
});


test('tab totals match inbox categories and exclude removed and cleared history',t=>{
  const s=setup(t);
  for(const [id,status,kind,reaction] of [['new','queued','','pending'],['ready','pending','','pending'],['auto','published','automatic','error'],['owner','published','edited','pending'],['old','published','','pending'],['skip','skipped','','error'],['dismissed','rejected','','error'],['removed','removed','','error'],['failed','error','','pending']]){add(s.store,id);s.store.update(id,{status,publish_kind:kind,reaction_status:reaction});}
  assert.deepEqual(s.store.tabCounts(),{all:3,new:3,pending:1,published:3,approved:1,automatic:1,error:3,rejected:1,skipped:1});
  s.store.clearHistory('skipped');s.store.clearHistory('rejected');const c=s.store.tabCounts();assert.equal(c.skipped,0);assert.equal(c.rejected,0);assert.equal(c.error,2);
});


test('reply publication applies Like afterward in every mode, without a separate approval',async t=>{
 for(const mode of ['approval','hybrid','automatic']){
  const s=setup(t);s.store.saveSettings({...s.store.settings(),mode});add(s.store);await s.workflow.generate('comment-1');const order=[];
  s.facebook.publish=async()=>{order.push('reply');return {id:'sent'};};s.facebook.like=async()=>{order.push('like');};
  await s.workflow.publish('comment-1',undefined,mode!=='approval');assert.deepEqual(order,['reply','like']);assert.equal(s.store.get('comment-1').reaction_applied,'LIKE');assert.equal(s.store.get('comment-1').like_after_publish,0);
 }
});
test('reply failure does not Like, and Like failure never makes a successful reply uncertain or sends it again',async t=>{
 const s=setup(t);add(s.store);await s.workflow.generate('comment-1');let likes=0;s.facebook.like=async()=>{likes++;throw new Error('Like interrupted');};
 const publish=s.facebook.publish;s.facebook.publish=async()=>{throw new Error('Reply interrupted');};await assert.rejects(s.workflow.publish('comment-1'));assert.equal(likes,0);
 s.store.update('comment-1',{status:'pending'});s.workflow.lastPublish=0;s.facebook.publish=publish;await s.workflow.publish('comment-1');
 const c=s.store.get('comment-1');assert.equal(c.status,'published');assert.equal(c.reaction_status,'uncertain');assert.equal(c.like_after_publish,0);assert.equal(s.workflow.memory.status().total,1);
 await assert.rejects(s.workflow.publish('comment-1'),/Only pending/);await s.workflow.tick();assert.equal(likes,1);assert.equal(s.posted(),1);
});
test('a queued Like recovers after a confirmed reply without AI access or duplicate concurrent attempts',async t=>{
 const s=setup(t);add(s.store);s.store.update('comment-1',{status:'published',like_after_publish:1});s.ai.status=()=>({enabled:false});let likes=0;
 s.facebook.like=async()=>{likes++;};await Promise.all([s.workflow.likePublished('comment-1'),s.workflow.tick()]);assert.equal(likes,1);assert.equal(s.store.get('comment-1').like_after_publish,0);await s.workflow.tick();assert.equal(likes,1);
 add(s.store,'interrupted');s.store.update('interrupted',{status:'published',like_after_publish:1,reaction_status:'uncertain',reaction_error:'Check Facebook'});await s.workflow.tick();assert.equal(likes,1);assert.equal(s.store.get('interrupted').reaction_status,'uncertain');
});


test('AI drafts, grammar corrections, and owner edits never publish em dashes',async t=>{
 const s=setup(t);add(s.store);s.ai.generate=async()=>({reply_decision:'REPLY',reply:'I hear you\u2014take your time.',needs_review:false});
 await s.workflow.generate('comment-1');assert.equal(s.store.get('comment-1').draft,'I hear you, take your time.');
 await s.workflow.generate('comment-1',undefined,'I hear you\u2014take your time.','grammar');assert.equal(s.store.get('comment-1').draft.includes('\u2014'),false);
 let sent;s.facebook.publish=async c=>{sent=c.draft;return {id:'reply'};};await s.workflow.publish('comment-1','I am listening\u2014you matter.');assert.equal(sent,'I am listening, you matter.');assert.equal(s.store.get('comment-1').draft,sent);
});


test('60-second spacing is between reply sends, not a delay after each comment arrives',async t=>{
 const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic',intervalSeconds:60});add(s.store,'one');await s.workflow.generate('one');
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);s.workflow.lastPublish=clock-60001;
 await s.workflow.publish('one',undefined,true);assert.equal(s.posted(),1);
 add(s.store,'two');await s.workflow.generate('two');clock+=59000;
 await assert.rejects(s.workflow.publish('two',undefined,true),/spacing/);assert.equal(s.posted(),1);
 clock+=1000;await s.workflow.publish('two',undefined,true);assert.equal(s.posted(),2);
});


test('arrival delay permits immediate drafts but blocks manual and automatic replies until both timing rules pass',async t=>{
 const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic',intervalSeconds:60,commentDelaySeconds:60});add(s.store,'one');const arrived=s.store.get('one').created_at;let clock=arrived;t.mock.method(Date,'now',()=>clock);s.workflow.lastPublish=0;
 await s.workflow.tick();assert.equal(s.store.get('one').status,'pending');assert.equal(s.posted(),0);assert.equal(s.store.nextPublish('automatic'),undefined);
 await assert.rejects(s.workflow.publish('one'),/comment delay/);assert.equal(s.posted(),0);
 clock=arrived+59999;await s.workflow.tick();assert.equal(s.posted(),0);clock=arrived+60000;await s.workflow.tick();assert.equal(s.posted(),1);
 add(s.store,'two');await s.workflow.generate('two');clock+=59999;await s.workflow.tick();assert.equal(s.posted(),1);clock+=1;await s.workflow.tick();assert.equal(s.posted(),2);
});
test('arrival delay changes during verification are checked before sending; test comments never wait',async t=>{
 const s=setup(t);add(s.store);await s.workflow.generate('comment-1');s.facebook.verify=async()=>s.store.saveSettings({...s.store.settings(),commentDelaySeconds:60});
 await assert.rejects(s.workflow.publish('comment-1'),/comment delay/);assert.equal(s.posted(),0);assert.equal(s.store.get('comment-1').status,'pending');
 add(s.store,'test','test');await s.workflow.generate('test');await s.workflow.publish('test');assert.equal(s.store.get('test').status,'simulated');
});


test('one-word AI acknowledgments skip without publishing or liking, while substantive questions remain recoverable',async t=>{
 const s=setup(t);s.store.saveSettings({...s.store.settings(),mode:'automatic'});add(s.store);s.store.update('comment-1',{message:'Yes'});s.ai.generate=async()=>({reply_decision:'REPLY',reply:'Yes ??',needs_review:false});let likes=0;s.facebook.like=async()=>likes++;
 await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'skipped');assert.equal(s.posted(),0);assert.equal(likes,0);
 add(s.store,'question');s.store.update('question',{message:'How do I learn to forgive myself?'});await s.workflow.generate('question');assert.equal(s.store.get('question').status,'error');assert.equal(s.store.get('question').draft,'');assert.equal(s.store.get('question').manual_hold,1);
 s.ai.generate=async()=>({reply_decision:'REPLY',reply:'Start by giving yourself the patience you give others.',needs_review:false});await s.workflow.generate('question');assert.equal(s.store.get('question').status,'pending');
 await assert.rejects(s.workflow.publish('question','Amen ??'),/One-word/);assert.equal(s.posted(),0);
});
test('legacy pending one-word replies are checked even without AI connectivity',async t=>{
 const s=setup(t);add(s.store);s.store.update('comment-1',{message:'Yes',status:'pending',draft:'Yes ??',reply_decision:'REPLY'});s.ai.status=()=>({enabled:false});await s.workflow.tick();assert.equal(s.store.get('comment-1').status,'skipped');assert.equal(s.posted(),0);
});


test('recent writing context is Page bound, limited, omits identities, and respects learning-off and grammar-only',async t=>{
 const s=setup(t);for(let i=0;i<8;i++){add(s.store,'sent'+i);s.store.update('sent'+i,{status:'published',draft:'Recent reply number '+i,published_at:1000+i});}
 add(s.store,'other');s.store.update('other',{status:'published',draft:'Other Page wording',published_at:9999});s.store.db.prepare("UPDATE comments SET page_id='456' WHERE id='other'").run();
 add(s.store,'next');let received;s.ai.generate=async(settings,c)=>{received=c;return {reply_decision:'REPLY',reply:c.grammarOnly?c.ownerInstructions:'A thoughtful fresh reply.',needs_review:false};};
 await s.workflow.generate('next');assert.deepEqual(received.recentPageReplies,['Recent reply number 7','Recent reply number 6','Recent reply number 5','Recent reply number 4','Recent reply number 3','Recent reply number 2']);
 assert.equal(received.recentPageReplies.some(x=>x.includes('Alex')||x.includes('Other Page')),false);
 await s.workflow.generate('next',undefined,'I appreciates your kindness.','grammar');assert.deepEqual(received.recentPageReplies,[]);
 s.store.saveSettings({...s.store.settings(),learningEnabled:false});await s.workflow.generate('next');assert.deepEqual(received.recentPageReplies,[]);
});

test('a queued comment that cannot be drafted does not block the queue',async t=>{
  const {store,workflow}=setup(t);
  store.add({id:'other-page',post_id:'999_1',message:'Hi',author:'A',source:'facebook'});
  store.db.prepare("UPDATE comments SET page_id='999',created_at=1 WHERE id='other-page'").run();
  store.add({id:'next',post_id:'123_456',message:'Love it!',author:'B',context:'New launch',source:'facebook'});
  await workflow.tick();
  assert.equal(store.get('other-page').status,'error');
  assert.match(store.get('other-page').error,/different Page/);
  await workflow.tick();
  assert.equal(store.get('next').status,'pending');
});

test('Live Off: the background worker drafts, posts and likes nothing',async t=>{
  const {store,workflow}=setup(t);
  store.saveSettings({...store.settings(),live:false});
  store.add({id:'off-1',post_id:'123_456',message:'Love it!',author:'B',context:'New launch',source:'facebook'});
  await workflow.tick();
  assert.equal(store.get('off-1').status,'queued');
});
