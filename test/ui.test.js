import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { followerMetrics, importFollowerReadings } from '../src/followers.js';

const html=readFileSync('public/index.html','utf8');
const script=readFileSync('public/app.js','utf8').replace('await refresh(true).catch(error=>notice(error.message,true));','window.__ready=refresh(true).catch(error=>notice(error.message,true));');
const comment=(id,status='pending',extra={})=>({id,author:'Alex',source:'facebook',post_id:'123_456',post_url:'https://www.facebook.com/123_456',post_loaded:1,created_at:Date.now(),message:'Love this product!',context:'A new launch',draft:'Thank you for the support!',review:0,reason:'',error:'',status,...extra});
async function setup(t,comments=[],guest=false) {
  const data={csrf:'test-csrf',settings:{personality:'Warm and helpful',knowledge:'Our FAQs',examples:'Thanks!',model:'',mode:'approval',aiProvider:'huggingface',hfSpace:'owner/space',pageId:'123',graphVersion:'v26.0',postIds:'',intervalSeconds:30},replyAI:{provider:'huggingface',enabled:true},huggingface:{hasToken:true},live:{on:true,receiving:true},facebook:{configured:true,hasAppSecret:true,verifyToken:'test-verify'},webhookUrl:'https://socialite.example.workers.dev/webhooks/facebook',memory:{enabled:true,total:0,counts:{},summary:null,revision:'0'},comments,activity:[{at:Date.now(),message:'Draft ready for Alex.'}]};
  if(guest){data.readOnly=true;data.comments=data.comments.filter(c=>c.status==='published'&&c.publish_kind==='automatic'&&c.source==='facebook'&&!c.cleared_at);data.cloudflare={available:true,reads:100,writes:2,readLimit:5000000,writeLimit:100000};}
  const dom=new JSDOM(html,{url:'http://127.0.0.1:8787',runScripts:'outside-only'});
  const w=dom.window, calls=[];
  w.__autoPublish=true;
  w.confirm=()=>{throw Error('Browser confirmation must never be used.');};
  Object.defineProperty(w.document,'hidden',{value:false,configurable:true});
  w.__stateRequests=[];
  w.__cloudflareRequests=0;
  w.__cloudflareUsage={available:true,reads:170113,writes:656,readLimit:5000000,writeLimit:100000,updatedAt:Date.now(),resetAt:Math.floor(Date.now()/86400e3)*86400e3+86400e3};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;if(this.id==='publish-dialog'&&w.__autoPublish)queueMicrotask(()=>w.document.getElementById('publish-confirm').click());};
  w.HTMLDialogElement.prototype.close=function(value){if(!this.open)return;if(value!==undefined)this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.setInterval=fn=>{w.__poll=fn;};
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.fetch=async(path,options)=>{
    if(path==='/api/cloudflare'){w.__cloudflareRequests++;return {ok:true,json:async()=>structuredClone(w.__cloudflareUsage)};}
    if(path.startsWith('/api/memory?')){const offset=Number(new URL(path,'http://127.0.0.1:8787').searchParams.get('offset'));const rows=w.__memoryRows||[];return {ok:true,json:async()=>({offset,total:rows.length,rows:rows.slice(offset,offset+20)})};}
    if(path==='/api/state'&&guest)return {status:401,ok:false};
    if(path==='/api/state'||path==='/api/public-state'){
      const etag=JSON.stringify(data);
      w.__stateRequests.push(options?.headers?.['If-None-Match']||'');
      if(options?.headers?.['If-None-Match']===etag)return {status:304,ok:false};
      return {status:200,ok:true,headers:{get:name=>name==='ETag'?etag:null},json:async()=>structuredClone(data)};
    }
    const input=JSON.parse(options.body);calls.push({path,input});
    if(path==='/api/facebook/follower-history'){data.facebook.followersHistory=importFollowerReadings(data.facebook,input.readings);Object.assign(data.facebook,followerMetrics(data.facebook));return {ok:true,json:async()=>followerMetrics(data.facebook)};}
    if(path==='/api/chatgpt/check')return {ok:true,json:async()=>({models:[{id:'gpt-6-sol',name:'GPT 6 Sol'},{id:'gpt-6-luna',name:'GPT 6 Luna'}]})};
    if(path==='/api/settings')Object.assign(data.settings,input);
    if(path==='/api/settings'&&'learningEnabled' in input)data.memory.enabled=input.learningEnabled;
    if(path==='/api/memory/delete'){w.__memoryRows=w.__memoryRows.filter(r=>r.comment_id!==input.id);data.memory.total=w.__memoryRows.length;data.memory.revision+='x';}
    if(path==='/api/memory/clear'){w.__memoryRows=[];data.memory.total=0;data.memory.revision+='x';}
    if(path==='/api/approve'){const c=data.comments.find(c=>c.id===input.id);c.status='published';c.reaction_applied='LIKE';c.reaction_status='applied';}
    if(path==='/api/draft'){const c=data.comments.find(c=>c.id===input.id);c.status='generating';if(w.__draftGate)await w.__draftGate;c.draft='A fresh generated reply.';c.status='pending';return {ok:true,json:async()=>({ok:true,status:c.status,reason:''})};}
    if(path==='/api/comments/clear'){const removed=data.comments.filter(c=>c.status===input.status).length;data.comments=data.comments.filter(c=>c.status!==input.status);return {ok:true,json:async()=>({ok:true,cleared:removed})};}
    if(path==='/api/reject'){data.comments.find(c=>c.id===input.id).status='rejected';}
    return {ok:true,json:async()=>({ok:true})};
  };
  w.eval(script);await w.__ready;
  t.after(()=>w.close());
  return {w,data,calls,$:s=>w.document.querySelector(s),input:(element,value)=>{element.value=value;element.dispatchEvent(new w.Event('input',{bubbles:true}));}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('themed publishing dialog previews edits, defaults to Keep editing, and Cancel sends nothing',async t=>{
  const s=await setup(t,[comment('one')]);s.w.__autoPublish=false;s.input(s.$('[data-draft="one"]'),'My exact edited reply.');
  const trigger=s.$('[data-action="approve"]');trigger.focus();trigger.click();await settle();
  assert.equal(s.$('#publish-dialog').open,true);assert.equal(s.w.document.activeElement,s.$('#publish-cancel'));
  assert.equal(s.$('#publish-recipient').textContent,'Alex');assert.equal(s.$('#publish-preview').textContent,'My exact edited reply.');assert.equal(s.calls.length,0);
  s.$('#publish-cancel').click();await settle();
  assert.equal(s.calls.length,0);assert.equal(s.data.comments[0].status,'pending');assert.equal(s.$('[data-draft="one"]').value,'My exact edited reply.');assert.equal(s.w.document.activeElement,trigger);
  trigger.click();await settle();s.$('#publish-confirm').click();await settle();
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].path,'/api/approve');assert.equal(s.calls[0].input.draft,'My exact edited reply.');
});

test('keyboard approval opens the themed dialog and cannot bypass it',async t=>{
  const s=await setup(t,[comment('one')]);s.w.__autoPublish=false;
  for(let i=0;i<2;i++)s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'a',bubbles:true}));
  await settle();assert.equal(s.$('#publish-dialog').open,true);assert.equal(s.calls.length,0);
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'a',bubbles:true}));await settle();assert.equal(s.calls.length,0);
  s.$('#publish-close').click();await settle();assert.equal(s.$('#publish-dialog').open,false);assert.equal(s.data.comments[0].status,'pending');
});

test('a changed draft cannot be published from an outdated confirmation preview',async t=>{
  const s=await setup(t,[comment('one')]);s.w.__autoPublish=false;s.$('[data-action="approve"]').click();await settle();
  s.data.comments[0].draft='A different reply arrived while reviewing.';await s.w.__poll();
  s.$('#publish-confirm').click();await settle();assert.equal(s.calls.length,0);assert.match(s.$('#notice').textContent,/changed while you were reviewing/);
});

test('Wine and Silence button sits beside regeneration and requests the preset with current edits',async t=>{
  const s=await setup(t,[comment('one')]);const button=s.$('[data-action="draft-personality"]');
  assert.ok(button);assert.equal(s.$('[data-action="draft"]').nextElementSibling,button);
  s.input(s.$('[data-draft="one"]'),'My current edit.');button.click();await settle();await settle();
  assert.equal(s.calls[0].path,'/api/draft');assert.equal(s.calls[0].input.personalityPreset,'wine-and-silence');assert.equal(s.calls[0].input.draft,'My current edit.');
  assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');assert.equal(s.$('[data-filter="pending"]').getAttribute('aria-pressed'),'true');
  s.data.comments[0].status='published';await s.w.__poll();s.$('[data-filter="published"]').click();assert.equal(s.$('[data-action="draft-personality"]'),null);
});

test('follow-ups display the original conversation, current message and mandatory approval',async t=>{
  const history=[{id:'original',author:'Alex',message:'The original comment',at:Date.now()-60000,isPage:false},{id:'page',author:'Our Page',message:'Our previous reply <script>untrusted</script>',at:Date.now()-30000,isPage:true}];
  const s=await setup(t,[comment('followup','pending',{is_followup:1,thread_history:JSON.stringify(history),message:'My follow-up question',manual_hold:1})]);
  assert.match(s.$('.thread-history').textContent,/The original comment/);assert.match(s.$('.thread-history').textContent,/Your Page/);assert.match(s.$('.thread-history').textContent,/Our previous reply/);
  assert.equal(s.$('.thread-history script'),null);assert.match(s.$('.row-state').textContent,/Follow-up/);
  assert.match(s.$('.said').textContent,/Latest follow-up/);assert.match(s.$('.convo-reply').textContent,/Always waits for your approval/);assert.ok(s.$('[data-action="approve"]'));
});

test('a follow-up without a suggested reply remains editable for an owner decision',async t=>{
  const s=await setup(t,[comment('followup','pending',{is_followup:1,draft:'',reply_decision:'REVIEW',reason:'Follow-up needs your decision.'})]);
  assert.ok(s.$('[data-draft="followup"]'));s.input(s.$('[data-draft="followup"]'),'My own thoughtful reply.');
  await s.w.__poll();assert.equal(s.$('[data-draft="followup"]').value,'My own thoughtful reply.');assert.ok(s.$('[data-action="approve"]'));
});

test('Cloudflare overview shows real percentages and Publishing lives in the sidebar',async t=>{
  const s=await setup(t);await s.w.__poll();
  assert.ok(s.$('aside #mode-label'));assert.equal(s.$('.kpis #mode-label'),null);
  assert.equal(s.$('#cf-reads').textContent,'3.4%');assert.equal(s.$('#cf-writes').textContent,'0.7%');
  assert.equal(s.$('#cf-status').textContent,'Healthy');
  const requests=s.w.__cloudflareRequests;await s.w.__poll();assert.equal(s.w.__cloudflareRequests,requests,'frequent dashboard checks do not fetch analytics again');
  s.$('#open-cloudflare').click();assert.equal(s.$('#cloudflare-dialog').open,true);assert.match(s.$('#cf-details').textContent,/170,113 \/ 5,000,000/);
  s.$('#close-cloudflare').click();assert.equal(s.w.document.activeElement,s.$('#open-cloudflare'));
});

test('Cloudflare warns near the limit and explicitly labels stale or unavailable usage',async t=>{
  const s=await setup(t);let now=s.w.Date.now();s.w.Date.now=()=>now;
  s.w.__cloudflareUsage.reads=4500000;await s.w.__poll();assert.equal(s.$('#cf-status').textContent,'Near limit');
  now+=300001;s.w.__cloudflareUsage.stale=true;await s.w.__poll();assert.equal(s.$('#cf-status').textContent,'Stale');
  now+=300001;s.w.__cloudflareUsage={available:false,error:'Cloudflare analytics is not connected.'};await s.w.__poll();
  assert.equal(s.$('#cf-status').textContent,'Unavailable');assert.equal(s.$('#cf-reads').textContent,'—');assert.match(s.$('#cf-details').textContent,/not connected/);
});

test('manual generation from No reply needed opens the new draft in Awaiting approval',async t=>{
  const s=await setup(t,[comment('playground','skipped',{source:'test',draft:'',reason:'Simple agreement with the post.'})]);
  s.$('[data-filter="skipped"]').click();
  assert.equal(s.$('[data-draft]'),null);
  s.$('[data-action="draft"]').click();await settle();await settle();
  assert.equal(s.$('[data-filter="pending"]').getAttribute('aria-pressed'),'true');
  assert.equal(s.$('[data-comment]').dataset.comment,'playground');
  assert.equal(s.$('[data-draft="playground"]').value,'A fresh generated reply.');
  assert.ok(s.$('[data-action="approve"]'));
  assert.match(s.$('#notice').textContent,/Draft ready for your approval/);
});

test('unchanged polling uses conditional requests and preserves the conversation DOM',async t=>{
  const s=await setup(t,[comment('one')]),panel=s.$('.convo');
  await s.w.__poll();
  assert.ok(s.w.__stateRequests.at(-1),'sends the previous ETag');
  assert.equal(s.$('.convo'),panel,'304 does not rebuild the conversation');
  s.data.comments[0].draft='Changed in the background';await s.w.__poll();
  assert.equal(s.$('[data-draft="one"]').value,'Changed in the background');
});

test('hidden tabs stop polling and resume with current data when visible',async t=>{
  const s=await setup(t,[comment('one')]);let hidden=true;
  Object.defineProperty(s.w.document,'hidden',{get:()=>hidden});
  const before=s.w.__stateRequests.length;
  s.data.comments[0].draft='Ready while tab was hidden';
  await s.w.__poll();assert.equal(s.w.__stateRequests.length,before);
  hidden=false;s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));await settle();
  assert.equal(s.w.__stateRequests.length,before+1);
  assert.equal(s.$('[data-draft="one"]').value,'Ready while tab was hidden');
});

test('database-limit responses show their explanation and suspend polling until Retry-After',async t=>{
  const s=await setup(t);const originalFetch=s.w.fetch,now=s.w.Date.now();let requests=0;
  s.w.fetch=async()=>{requests++;return {status:503,ok:false,headers:{get:()=>120},json:async()=>({error:'Daily database allowance reached.'})};};
  await s.w.__poll();assert.equal(requests,1);
  assert.match(s.w.document.body.textContent,/Daily database allowance reached/);
  await s.w.__poll();assert.equal(requests,1,'no repeated requests during outage');
  s.w.Date.now=()=>now+121000;s.w.fetch=async(...args)=>{if(args[0]==='/api/state')requests++;return originalFetch(...args);};
  await s.w.__poll();assert.equal(requests,2,'automatically retries when allowed');
});
test('sidebar test-comment action opens the form from Activity and returns focus on close',async t=>{
  const s=await setup(t);
  assert.ok(s.$('aside #open-test'));
  assert.equal(s.$('#queue .top #open-test'),null);
  assert.equal(s.$('#empty-test'),null);
  s.w.location.hash='#activity';await settle();
  s.$('#open-test').click();
  assert.equal(s.$('#queue').hidden,false);
  assert.equal(s.$('#test-form').hidden,false);
  assert.equal(s.w.document.activeElement,s.$('#test-form textarea[name="message"]'));
  s.$('#close-test').click();
  assert.equal(s.$('#test-form').hidden,true);
  assert.equal(s.w.document.activeElement,s.$('#open-test'));
});

test('redesigned dashboard loads all panels and preserves connection inputs',async t=>{
  const s=await setup(t,[comment('one'),comment('two','published'),comment('three','error')]);
  assert.equal(s.$('#notice').hidden,true);assert.equal(s.$('#pause'),null);
  assert.equal(s.$('#stat-pending').textContent,'1');assert.equal(s.$('#stat-published').textContent,'1');
  assert.equal(s.$('#rail-ai-status').textContent,'ZeroGPU Space');assert.equal(s.$('#webhook-address').value,'https://socialite.example.workers.dev/webhooks/facebook');assert.equal(s.$('#rail-fb-status').textContent,'Page 123');
  assert.equal(s.$('#personality-input').value,'Warm and helpful');assert.equal(s.$('#page-input').value,'123');
  assert.equal(s.$('input[name="pageToken"]').type,'password');assert.equal(s.$('input[name="appSecret"]').type,'password');
  const ids=[...s.w.document.querySelectorAll('[id]')].map(e=>e.id);assert.equal(new Set(ids).size,ids.length);
});
test('Reply AI settings offer and save all three provider choices',async t=>{
  const s=await setup(t);
  const radios=[...s.w.document.querySelectorAll('input[name="aiProvider"]')];
  assert.deepEqual(radios.map(radio=>radio.closest('label').querySelector('strong').textContent),['ChatGPT','Hugging Face','ChatGPT + Hugging Face']);
  assert.equal(radios.find(radio=>radio.checked).value,'huggingface');
  assert.equal(s.$('#hf-fields').hidden,false);
  for(const provider of ['chatgpt','huggingface','fallback']){
    const radio=radios.find(radio=>radio.value===provider);
    radio.checked=true;radio.dispatchEvent(new s.w.Event('change',{bubbles:true}));
    assert.equal(s.$('#hf-fields').hidden,provider==='chatgpt');
    s.$('#ai-provider-form button[type="submit"]').click();
    await settle();await settle();
    assert.equal(s.calls.at(-1).input.aiProvider,provider);
  }
});
test('ChatGPT panel loads models and saves the selected reply model',async t=>{
  const s=await setup(t);
  s.data.chatgpt={enabled:true,email:'owner@example.com'};
  await s.w.__poll();
  assert.equal(s.$('#ai-status').textContent,'Plan connected');
  assert.match(s.$('#ai-description').textContent,/owner@example.com/);
  s.$('#load-models').click();await settle();await settle();
  assert.deepEqual([...s.$('#model-select').options].map(option=>option.value),['gpt-6-sol','gpt-6-luna']);
  s.$('#model-select').value='gpt-6-luna';
  s.$('#model-select').dispatchEvent(new s.w.Event('change'));
  s.$('#save-model').click();await settle();await settle();
  assert.deepEqual(s.calls.at(-1),{path:'/api/settings',input:{model:'gpt-6-luna'}});
  assert.equal(s.$('#model-saved').textContent,'Saved model: gpt-6-luna');
});
test('24h tiles show received and handled activity after comments leave their current status',async t=>{
  const s=await setup(t,[comment('published','published',{created_at:Date.now()-3600e3,published_at:Date.now()-1800e3,publish_kind:'automatic'})]);
  const now=Date.now();
  s.data.kpiTimes={new:Array(12).fill(now-3600e3),pending:[now-3000e3,now-2000e3],published:[now-1800e3],automatic:[now-1800e3]};
  await s.w.__poll();
  assert.equal(s.$('#stat-new').textContent,'0');
  assert.equal(s.$('#delta-new').textContent,'+12 in 24h');
  assert.equal(s.$('#delta-pending').textContent,'+2 in 24h');
  assert.equal(s.$('#delta-published').textContent,'+1 in 24h');
  assert.equal(s.$('#stat-auto').textContent,'1');
  assert.equal(s.$('#delta-auto').textContent,'+1 in 24h');
});
test('old published replies with Like warnings stay out of New, including after polling',async t=>{
  const s=await setup(t,[comment('liked','published',{created_at:Date.parse('2026-10-09T03:27:02Z'),reaction_status:'uncertain',reaction_error:'Check Facebook'})]);
  assert.equal(s.$('[data-filter="error"]'),null);
  assert.equal(s.$('#stat-new').textContent,'0');
  assert.equal(s.$('#nav-count').textContent,'0');
  s.$('[data-filter="new"]').click();
  assert.equal(s.$('[data-comment="liked"]'),null);
  await s.w.__poll();
  assert.equal(s.$('[data-comment="liked"]'),null);
  assert.equal(s.$('#stat-new').textContent,'0');
  s.$('[data-filter="published"]').click();
  assert.ok(s.$('[data-comment="liked"]'));
  assert.match(s.$('[data-row="liked"] .row-state').textContent,/Like needs checking/);
});
test('search matches comment, author, post caption, and reply text',async t=>{
  const s=await setup(t,[comment('one'),comment('two','pending',{author:'Sam',message:'Shipping question',context:'Summer collection',draft:'Delivery takes three days.'})]);
  for(const query of ['Sam','shipping','summer','three days']) {s.input(s.$('#comment-search'),query);assert.equal(s.w.document.querySelectorAll('.convo').length,1);assert.equal(s.$('.convo').dataset.comment,'two');}
  s.input(s.$('#comment-search'),'not found');assert.match(s.$('#comments').textContent,/No matching/);
});
test('unsaved draft survives filtering, search, and polling',async t=>{
  const s=await setup(t,[comment('one'),comment('two','published')]);
  s.input(s.$('[data-draft="one"]'),'My edited reply');
  s.$('[data-filter="published"]').click();s.$('[data-filter="new"]').click();
  assert.equal(s.$('[data-draft="one"]').value,'My edited reply');
  s.input(s.$('#comment-search'),'not found');s.input(s.$('#comment-search'),'');
  await s.w.__poll();await settle();assert.equal(s.$('[data-draft="one"]').value,'My edited reply');
});
test('approval sends the edited draft and updates the comment status',async t=>{
  const s=await setup(t,[comment('one')]);s.input(s.$('[data-draft="one"]'),'My approved reply');
  s.$('[data-action="approve"]').click();await settle();
  assert.equal(s.calls[0].path,'/api/approve');assert.equal(s.calls[0].input.draft,'My approved reply');
  assert.equal(s.$('.convo'),null);s.$('[data-filter="published"]').click();
  assert.match(s.$('.convo-head .state').textContent,/Published/);assert.equal(s.$('[data-draft="one"]').readOnly,true);
  assert.equal(s.$('.convo-reply h3').textContent,'Published reply');
  assert.equal(s.$('.reply-flag').textContent,'Sent');
  assert.equal(s.$('[data-action="approve"]'),null);
});

test('post context, customer comment, and AI reply are distinct and publication labels reflect state',async t=>{
  const s=await setup(t,[comment('pending'),comment('sent','published'),comment('discarded','rejected'),comment('test','simulated',{source:'test'}),comment('waiting','generating',{draft:''})]);
  const card=id=>s.$(`[data-comment="${id}"]`);
  const pending=card('pending');
  assert.equal(pending.querySelector('.post .post-text').textContent,'A new launch');
  assert.equal(pending.querySelector('.said .said-text').textContent,'Love this product!');
  assert.equal(pending.querySelector('.convo-reply textarea').value,'Thank you for the support!');
  assert.deepEqual([...pending.querySelectorAll('h3')].map(h=>h.textContent),['Your Facebook post / Reel','Customer comment','AI reply draft']);
  assert.equal(pending.querySelector('.reply-flag').textContent,'Not published');
  assert.equal(card('discarded'),null);
  assert.equal(card('test'),null);
  assert.match(card('waiting').querySelector('.empty-reply').textContent,/AI is writing/);
  assert.equal(card('waiting').querySelector('[data-action="approve"]'),null);
  s.$('[data-filter="rejected"]').click();assert.equal(card('discarded').querySelector('.reply-flag').textContent,'Not sent');assert.equal(card('discarded').querySelector('[data-draft]').readOnly,true);
});

test('published conversations stay out of All comments, including searches and polling, but remain in Published',async t=>{
  const s=await setup(t,[comment('pending'),comment('sent','published',{author:'Published person'}),comment('error','error')]);
  assert.equal(s.$('[data-comment="sent"]'),null);assert.equal(s.$('#inbox-count').textContent,'2 comments');
  s.input(s.$('#comment-search'),'Published person');assert.equal(s.$('.convo'),null);
  s.$('[data-filter="published"]').click();assert.ok(s.$('[data-comment="sent"]'));
  s.input(s.$('#comment-search'),'');s.$('[data-filter="new"]').click();await s.w.__poll();await settle();assert.equal(s.$('[data-comment="sent"]'),null);
});
test('explicit regeneration displays the new draft instead of a stale edit',async t=>{
  const s=await setup(t,[comment('one')]);s.input(s.$('[data-draft="one"]'),'My old edit');
  s.$('[data-action="draft"]').click();await settle();
  assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');
});

test('polling during regeneration cannot restore an old edited reply over the new draft',async t=>{
  const s=await setup(t,[comment('one')]);let release;s.w.__draftGate=new Promise(r=>{release=r;});
  s.input(s.$('[data-draft="one"]'),'Old edited wording');s.$('[data-action="draft"]').click();
  await s.w.__poll();await settle();release();await settle();
  assert.equal(s.calls[0].input.draft,'Old edited wording');assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');
  await s.w.__poll();await settle();assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');
});

test('Awaiting approval keeps the selected conversation visible through multiple regeneration polls',async t=>{
  const s=await setup(t,[comment('one'),comment('two')]);let release;s.w.__draftGate=new Promise(r=>{release=r;});
  s.$('[data-filter="pending"]').click();s.$('[data-row="one"]').click();
  s.input(s.$('[data-draft="one"]'),'My edited reply before regeneration');
  s.input(s.$('[data-idea="one"]'),'Make it more personal');s.$('[data-action="refine"]').click();
  for(let i=0;i<2;i++){
    await s.w.__poll();await settle();
    assert.ok(s.$('[data-row="one"]'),'regenerating row stays in its current tab');
    assert.equal(s.$('[data-row="one"]').getAttribute('aria-selected'),'true','selection does not jump to another comment');
    assert.equal(s.$('[data-draft="one"]').value,'My edited reply before regeneration');
    assert.equal(s.$('[data-draft="one"]').readOnly,true);
    assert.match(s.$('[data-comment="one"]').textContent,/AI is working/);
    assert.equal(s.$('[data-comment="one"] [data-action="approve"]'),null,'cannot approve an in-flight draft');
  }
  release();await settle();await settle();
  assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');
  assert.equal(s.$('[data-draft="one"]').readOnly,false);assert.ok(s.$('[data-comment="one"] [data-action="approve"]'));
});

test('a new server draft supersedes a cached edit of the previous draft',async t=>{
  const s=await setup(t,[comment('one')]);s.input(s.$('[data-draft="one"]'),'Old edited wording');
  s.data.comments[0].draft='Updated by generation';await s.w.__poll();await settle();assert.equal(s.$('[data-draft="one"]').value,'Updated by generation');
});

test('dismissing a reply leaves a regeneration action without separate reaction controls',async t=>{
  const s=await setup(t,[comment('one')]);s.$('[data-action="reject"]').click();await settle();
  assert.equal(s.$('.convo'),null);await s.w.__poll();await settle();assert.equal(s.$('.convo'),null);
  s.$('[data-filter="rejected"]').click();
  assert.match(s.$('.convo-head .state').textContent,/Reply dismissed/);assert.equal(s.$('[data-action="approve"]'),null);
  assert.equal(s.$('[data-reaction="one"]'),null);assert.match(s.$('.like-text').textContent,/only if you publish/);
  s.$('[data-filter="rejected"]').click();assert.ok(s.$('.convo'));assert.match(s.$('[data-action="draft"]').textContent,/Generate new reply/);
  s.$('[data-action="draft"]').click();await settle();s.$('[data-filter="new"]').click();
  assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');assert.ok(s.$('[data-action="approve"]'));
});
test('comment text is escaped and unsafe post links are replaced',async t=>{
  const s=await setup(t,[comment('one','pending',{author:'<img src=x onerror=alert(1)>',message:'<script>bad()</script>',draft:'</textarea><script>bad()</script>',post_url:'javascript:alert(1)'})]);
  assert.equal(s.$('#comments script'),null);assert.equal(s.$('#comments img'),null);
  assert.match(s.$('.said-text').textContent,/<script>/);assert.match(s.$('.ext').href,/https:\/\/www.facebook.com\//);
});
test('navigation and filter buttons expose their current state',async t=>{
  const s=await setup(t,[comment('one')]);s.w.location.hash='#personality';await settle();
  assert.equal(s.$('#personality').hidden,false);assert.equal(s.$('#queue').hidden,true);
  assert.equal(s.$('[data-nav="personality"]').getAttribute('aria-current'),'page');
  s.$('[data-filter="pending"]').click();assert.equal(s.$('[data-filter="pending"]').getAttribute('aria-pressed'),'true');
});

test('Like is included in publication with no dropdown or separate approval, preserving edits',async t=>{
  const s=await setup(t,[comment('one')]);s.input(s.$('[data-draft="one"]'),'My edited reply');
  assert.equal(s.$('[data-reaction]'),null);assert.equal(s.$('[data-action="reaction-approve"]'),null);assert.equal(s.$('[data-action="reaction-confirm"]'),null);
  assert.match(s.$('.like-text').textContent,/No separate approval/);await s.w.__poll();await settle();assert.equal(s.$('[data-draft="one"]').value,'My edited reply');
  s.$('[data-action="approve"]').click();await settle();s.$('[data-filter="published"]').click();
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].path,'/api/approve');assert.equal(s.calls[0].input.draft,'My edited reply');assert.match(s.$('.like-h').textContent,/Liked/);
});

test('Like failure stays visible on the published reply without offering to republish',async t=>{
 const s=await setup(t,[comment('sent','published',{reaction_status:'uncertain',reaction_error:'Check Facebook before retrying.',reaction_applied:'NONE'})]);
 s.$('[data-filter="published"]').click();assert.match(s.$('.like-text').textContent,/reply remains published/);assert.ok(s.$('.like a'));assert.equal(s.$('[data-action="approve"]'),null);assert.equal(s.$('[data-reaction]'),null);
});

test('owner ideas survive polling and filters, are sent separately, and produce a reviewable reply',async t=>{
  const s=await setup(t,[comment('one')]);
  s.input(s.$('[data-idea="one"]'),'Thank them for their encouragement. Make it personal.');
  s.input(s.$('[data-draft="one"]'),'My rough wording');
  s.$('[data-filter="published"]').click();s.$('[data-filter="new"]').click();
  const idea=s.$('[data-idea="one"]');idea.focus();idea.setSelectionRange(4,7);
  await s.w.__poll();await settle();
  assert.equal(s.$('[data-idea="one"]').value,'Thank them for their encouragement. Make it personal.');
  assert.equal(s.w.document.activeElement.dataset.idea,'one');assert.equal(s.w.document.activeElement.selectionStart,4);
  s.$('[data-action="refine"]').click();await settle();
  assert.equal(s.calls[0].path,'/api/draft');assert.equal(s.calls[0].input.draft,'My rough wording');
  assert.equal(s.calls[0].input.instructions,'Thank them for their encouragement. Make it personal.');
  assert.equal(s.$('[data-draft="one"]').value,'A fresh generated reply.');assert.ok(s.$('[data-action="approve"]'));
  assert.equal(s.calls.some(c=>c.path==='/api/approve'),false);
});

test('blank AI instructions are rejected locally and published cards have no AI composer',async t=>{
  const s=await setup(t,[comment('one'),comment('sent','published')]);
  s.$('[data-action="refine"]').click();await settle();assert.equal(s.calls.length,0);assert.match(s.$('#notice').textContent,/Write your idea/);
  s.$('[data-filter="published"]').click();assert.equal(s.$('[data-idea]'),null);
});


test('connected Facebook Page name is visible globally and in Connections after polling',async t=>{
  const s=await setup(t);s.data.facebook.pageName='Our Community';await s.w.__poll();await settle();
  assert.equal(s.$('#rail-fb-status').textContent,'Our Community');assert.match(s.$('#rail-fb-status').title,/123/);
  assert.equal(s.$('#fb-status').textContent,'Our Community');
  s.data.facebook.configured=false;await s.w.__poll();await settle();assert.equal(s.$('#rail-fb-status').textContent,'Not configured');
});


test('reply memory can be reviewed, paginated, disabled, and forgotten without deleting comments',async t=>{
  const s=await setup(t,[comment('one','published')]);
  s.w.__memoryRows=Array.from({length:25},(_,i)=>({comment_id:'m'+i,comment:'Customer '+i,post:'Post',reply:'Reply '+i,kind:i?'approved':'edited',published_at:Date.now()}));
  s.data.memory.total=25;s.data.memory.revision='25';await s.w.__poll();await settle();
  s.w.location.hash='#personality';await settle();await settle();
  assert.equal(s.w.document.querySelectorAll('.mem').length,20);assert.match(s.$('#memory-page').textContent,/1-20 of 25/);
  s.$('#memory-next').click();await settle();assert.equal(s.w.document.querySelectorAll('.mem').length,5);assert.match(s.$('#memory-page').textContent,/21-25/);
  s.$('#memory-toggle').click();await settle();assert.equal(s.$('#memory-toggle').textContent,'Turn learning on');assert.match(s.$('#memory-status').textContent,/Learning is off/);
  s.$('[data-memory-delete]').click();await settle();await settle();assert.equal(s.data.memory.total,24);
  s.$('#memory-clear').click();await settle();await settle();assert.equal(s.data.memory.total,0);assert.equal(s.$('#memory-clear').disabled,true);
  assert.equal(s.data.comments.length,1);assert.equal(s.data.comments[0].status,'published');
});


test('Facebook followers display exact integers, zero, and a fetch time without compact abbreviations',async t=>{
  const s=await setup(t);s.data.facebook.followersCount=7045;s.data.facebook.followersUpdatedAt=Date.now();await s.w.__poll();await settle();
  assert.equal(s.$('#rail-fb-followers').textContent,'7,045 followers');assert.equal(s.$('#rail-fb-followers').hidden,false);
  assert.match(s.$('#rail-fb-updated').textContent,/Updated/);assert.match(s.$('#rail-fb-updated').title,/5 minutes/);
  s.data.facebook.followersCount=0;await s.w.__poll();await settle();assert.equal(s.$('#rail-fb-followers').textContent,'0 followers');
  s.data.facebook.followersCount=null;await s.w.__poll();await settle();assert.equal(s.$('#rail-fb-followers').textContent,'Followers unavailable');assert.equal(s.$('#rail-fb-updated').hidden,true);
  s.data.facebook.configured=false;await s.w.__poll();await settle();assert.equal(s.$('#rail-fb-followers').hidden,true);
});


test('grammar-only choice survives filtering and polling, preserves the idea, and sends the correct operation',async t=>{
  const s=await setup(t,[comment('one')]);s.input(s.$('[data-idea="one"]'),'I appreciates your support!');
  const select=s.$('[data-idea-mode="one"]');select.value='grammar';select.dispatchEvent(new s.w.Event('change',{bubbles:true}));
  assert.equal(s.$('[data-idea="one"]').value,'I appreciates your support!');assert.equal(s.$('[data-idea="one"]').maxLength,1000);
  assert.match(s.$('[data-action="refine"]').textContent,/Correct grammar/);
  s.$('[data-filter="published"]').click();s.$('[data-filter="new"]').click();await s.w.__poll();await settle();
  assert.equal(s.$('[data-idea-mode="one"]').value,'grammar');assert.equal(s.$('[data-idea="one"]').value,'I appreciates your support!');
  s.$('[data-action="refine"]').click();await settle();
  assert.equal(s.calls[0].input.editingMode,'grammar');assert.equal(s.calls[0].input.instructions,'I appreciates your support!');
  assert.equal(s.$('[data-idea="one"]').value,'I appreciates your support!');assert.ok(s.$('[data-action="approve"]'));
});


test('new comments are visible before drafting, update while polling, and can be opened from the overview',async t=>{
  const s=await setup(t,[comment('queued','queued',{draft:''}),comment('drafting','generating',{draft:''}),comment('ready'),comment('sent','published'),comment('dismissed','rejected'),comment('removed','removed'),comment('error','error')]);
  assert.equal(s.$('#stat-new').textContent,'4');assert.equal(s.$('#nav-count').textContent,'4');
  s.input(s.$('#comment-search'),'not found');s.$('#show-new-comments').click();
  assert.equal(s.$('#comment-search').value,'');assert.equal(s.w.document.querySelectorAll('.convo').length,4);assert.ok(s.$('[data-comment="error"]'));
  assert.equal(s.$('[data-filter="new"]').getAttribute('aria-pressed'),'true');
  s.data.comments.find(c=>c.id==='queued').status='published';await s.w.__poll();await settle();assert.equal(s.$('#stat-new').textContent,'3');
  s.data.comments.push(comment('incoming','queued',{draft:''}));await s.w.__poll();await settle();assert.equal(s.$('#stat-new').textContent,'4');assert.ok(s.$('[data-comment="incoming"]'));
});


test('no-reply comments are archived out of All and new counts but show their reason and reassessment control',async t=>{
  const s=await setup(t,[comment('skip','skipped',{draft:'',reply_decision:'SKIP',reason:'Random keyboard text.'}),comment('unclear','pending',{reply_decision:'REVIEW'})]);
  assert.equal(s.$('[data-comment="skip"]'),null);assert.equal(s.$('#stat-new').textContent,'1');
  assert.match(s.$('[data-comment="unclear"]').textContent,/Meaning needs review/);
  s.$('[data-filter="skipped"]').click();assert.match(s.$('.convo-head .state').textContent,/No reply needed/);
  assert.match(s.$('.note').textContent,/Random keyboard text/);assert.ok(s.$('[data-action="draft"]'));assert.equal(s.$('[data-action="approve"]'),null);
});


test('Page relevance policy and emoji-only preference are visible and saved with the personality',async t=>{
  const s=await setup(t);s.data.settings.replyPolicy='Life lessons only';s.data.settings.replyPolicyPageId='123';s.data.settings.skipEmojiOnly=true;
  s.w.location.hash='#personality';await settle();
  s.input(s.$('#reply-policy-input'),'Skip unrelated chatter.');s.$('#skip-emoji-input').checked=true;
  s.$('#personality-form button[type="submit"], #personality-form button.primary').click();await settle();
  const saved=s.calls.find(c=>c.path==='/api/settings');assert.equal(saved.input.replyPolicy,'Skip unrelated chatter.');assert.equal(saved.input.skipEmojiOnly,true);
});


test('published tabs separate owner approvals from automatic sends, preserve unknown history, and sort by send time',async t=>{
  const s=await setup(t,[comment('manual','published',{publish_kind:'approved',published_at:200,created_at:10}),comment('edited','published',{publish_kind:'edited',published_at:400,created_at:5}),comment('auto-old','published',{publish_kind:'automatic',published_at:100,created_at:50}),comment('auto-new','published',{publish_kind:'automatic',published_at:300,created_at:1,message:'auto-new'}),comment('legacy','published'),comment('not-sent','pending',{publish_kind:'automatic'}),comment('test','simulated',{publish_kind:'approved',source:'test'})]);
  const ids=()=>[...s.w.document.querySelectorAll('.convo')].map(c=>c.dataset.comment);
  s.$('[data-filter="approved"]').click();assert.deepEqual(ids(),['edited','manual']);
  assert.match(s.$('[data-comment="edited"] .reply-meta').textContent,/You edited/);
  s.$('[data-filter="automatic"]').click();assert.deepEqual(ids(),['auto-new','auto-old']);
  assert.match(s.$('.convo-head .state').textContent,/Automatically published/);
  s.input(s.$('#comment-search'),'auto-new');assert.deepEqual(ids(),['auto-new']);
  s.input(s.$('#comment-search'),'');
  s.data.comments.find(c=>c.id==='not-sent').status='published';s.data.comments.find(c=>c.id==='not-sent').published_at=500;
  await s.w.__poll();await settle();assert.deepEqual(ids(),['not-sent','auto-new','auto-old']);
  s.$('[data-filter="published"]').click();assert.equal(ids().length,6);
  assert.match(s.$('[data-comment="legacy"] .reply-meta').textContent,/method unavailable/);
  s.$('[data-filter="new"]').click();assert.equal(s.$('[data-comment="auto-new"]'),null);
});


test('Clear all appears only in archived tabs and clears the category regardless of search',async t=>{
  const s=await setup(t,[comment('skip1','skipped'),comment('skip2','skipped'),comment('dismissed','rejected'),comment('published','published'),comment('pending')]);
  const clear=s.$('#clear-comment-history');assert.equal(clear.hidden,true);
  s.$('[data-filter="skipped"]').click();assert.equal(clear.hidden,false);assert.equal(clear.disabled,false);
  s.input(s.$('#comment-search'),'no matches');assert.equal(s.$('.convo'),null);assert.equal(clear.disabled,false);
  clear.click();await settle();await settle();
  assert.deepEqual(s.calls.at(-1),{path:'/api/comments/clear',input:{status:'skipped'}});assert.equal(clear.disabled,true);
  assert.equal(s.data.comments.filter(c=>c.status==='skipped').length,0);assert.equal(s.data.comments.length,3);
  s.input(s.$('#comment-search'),'');s.$('[data-filter="rejected"]').click();assert.equal(clear.disabled,false);
  clear.click();await settle();await settle();assert.equal(s.data.comments.some(c=>c.status==='rejected'),false);
  s.$('[data-filter="published"]').click();assert.equal(clear.hidden,true);assert.ok(s.$('[data-comment="published"]'));
});


test('every tab shows its total, independent of search, and counts update after polling and clearing',async t=>{
  const s=await setup(t,[comment('pending'),comment('queued','queued'),comment('auto','published',{publish_kind:'automatic'}),comment('owner','published',{publish_kind:'edited'}),comment('legacy','published'),comment('error','error'),comment('skip','skipped'),comment('dismissed','rejected'),comment('removed','removed')]);
  const expected={new:3,pending:1,published:3,approved:1,automatic:1,rejected:1,skipped:1};
  for(const [key,n] of Object.entries(expected)){
    const button=s.$(`[data-filter="${key}"]`);
    if(button.classList.contains('kpi'))assert.equal(button.querySelector('.kpi-n').textContent,String(n));
    else assert.match(button.textContent,new RegExp('\\('+n+'\\)$'));
  }
  s.input(s.$('#comment-search'),'no matching text');assert.match(s.$('[data-filter="skipped"]').textContent,/\(1\)$/);
  s.data.comments.find(c=>c.id==='queued').status='pending';await s.w.__poll();await settle();assert.equal(s.$('#stat-pending').textContent,'2');
  s.$('[data-filter="skipped"]').click();s.$('#clear-comment-history').click();await settle();await settle();assert.match(s.$('[data-filter="skipped"]').textContent,/\(0\)$/);
  s.data.tabCounts={...expected,skipped:1234};await s.w.__poll();await settle();assert.equal(s.$('[data-filter="skipped"]').textContent,'No reply needed (1,234)');
});


test('received and published times are clearly labeled and show seconds even within the same minute',async t=>{
 const received=Date.parse('2026-10-10T14:19:22.611Z'),published=Date.parse('2026-10-10T14:19:36.946Z');
 const s=await setup(t,[comment('one','published',{created_at:received,published_at:published,publish_kind:'automatic'})]);s.$('[data-filter="automatic"]').click();
 assert.match(s.$('.convo-head time').textContent,/Received:/);assert.match(s.$('.convo-head time').textContent,/:22/);assert.equal(s.$('.convo-head time').getAttribute('datetime'),new Date(received).toISOString());
 assert.match(s.$('.reply-meta').textContent,/Published at/);assert.match(s.$('.reply-meta').textContent,/:36/);
});


test('arrival-delay field is saved separately from spacing and explains a waiting draft',async t=>{
 const s=await setup(t,[comment('one')]);s.data.settings.commentDelaySeconds=60;await s.w.__poll();await settle();assert.match(s.$('.convo-reply').textContent,/Minimum comment delay/);
 s.$('#interval-input').value='60';s.$('#comment-delay-input').value='90';s.$('#rules-form button').click();await settle();
 const request=s.calls.find(c=>c.path==='/api/settings');assert.equal(request.input.intervalSeconds,'60');assert.equal(request.input.commentDelaySeconds,'90');
});


test('three-pane inbox: rows select one conversation; J/K move; the detail keeps unsent edits',async t=>{
  const s=await setup(t,[comment('one',undefined,{created_at:3}),comment('two',undefined,{created_at:2,author:'Sam'})]);
  const shown=()=>[...s.w.document.querySelectorAll('#comments [data-comment]')].filter(d=>!d.hidden).map(d=>d.dataset.comment);
  assert.equal(s.w.document.querySelectorAll('#comment-rows [data-row]').length,2);assert.deepEqual(shown(),['one']);
  s.input(s.$('[data-draft="one"]'),'Edited before switching');
  const key=k=>s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:k,bubbles:true}));
  key('j');assert.deepEqual(shown(),['two']);assert.equal(s.$('[data-row="two"]').getAttribute('aria-selected'),'true');
  key('k');assert.deepEqual(shown(),['one']);assert.equal(s.$('[data-draft="one"]').value,'Edited before switching');
  s.$('[data-row="two"]').click();assert.deepEqual(shown(),['two']);assert.equal(s.$('#workspace').dataset.pane,'detail');
  s.$('[data-comment="two"] [data-back]').click();assert.equal(s.$('#workspace').dataset.pane,'list');
});

test('keyboard approve needs two presses of A, and typing in a field never triggers shortcuts',async t=>{
  const s=await setup(t,[comment('one')]);
  const key=(k,target=s.w.document)=>target.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:k,bubbles:true}));
  key('a',s.$('[data-draft="one"]'));await settle();assert.equal(s.calls.length,0);
  key('a');await settle();assert.equal(s.calls.length,0);assert.match(s.$('#notice').textContent,/Press A again/);
  key('a');await settle();assert.equal(s.calls[0].path,'/api/approve');
});

test('only the three secondary filters appear below the clickable overview and the command palette works',async t=>{
  const s=await setup(t,[comment('one'),comment('skip','skipped')]);
  assert.equal(s.$('#filter-more'),null);
  assert.deepEqual([...s.w.document.querySelectorAll('.list-tools [data-filter]')].map(b=>b.dataset.filter),['rejected','skipped','approved']);
  s.$('[data-filter="skipped"]').click();assert.equal(s.$('[data-filter="skipped"]').getAttribute('aria-pressed'),'true');
  assert.ok(s.$('[data-comment="skip"]'));
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));assert.equal(s.$('#palette').hidden,false);
  s.input(s.$('#palette-input'),'connections');s.$('#palette-input').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();
  assert.equal(s.$('#palette').hidden,true);assert.equal(s.w.location.hash,'#connections');
});
test('each overview card opens its list, clears search and preserves its count after polling',async t=>{
  const s=await setup(t,[comment('waiting'),comment('queued','queued'),comment('auto','published',{publish_kind:'automatic'}),comment('manual','published',{publish_kind:'approved'})]);
  const expected={new:['waiting','queued'],pending:['waiting'],published:['auto','manual'],automatic:['auto']};
  for(const [key,ids] of Object.entries(expected)){
    s.input(s.$('#comment-search'),'no matches');
    const card=s.$(`.kpi[data-filter="${key}"]`),count=card.querySelector('.kpi-n').textContent;
    card.click();
    assert.equal(s.$('#comment-search').value,'');
    assert.deepEqual([...s.w.document.querySelectorAll('[data-row]')].map(row=>row.dataset.row).sort(),ids.sort());
    assert.equal(card.getAttribute('aria-pressed'),'true');
    await s.w.__poll();
    assert.equal(card.querySelector('.kpi-n').textContent,count);
    assert.equal(card.getAttribute('aria-pressed'),'true');
  }
});

test('a refresh with nothing new leaves the open conversation untouched (no twitch, scroll kept)',async t=>{
  const s=await setup(t,[comment('one'),comment('two')]);
  const before=s.$('[data-comment="one"]'), row=s.$('[data-row="one"]');
  before.querySelector('.convo-reply').scrollTop=120;
  await s.w.__poll();await settle();
  assert.equal(s.$('[data-comment="one"]'),before,'conversation element was not rebuilt');
  assert.equal(s.$('[data-row="one"]'),row,'list row was not rebuilt');
  assert.equal(before.querySelector('.convo-reply').scrollTop,120);
  s.data.comments[0].draft='A real update';await s.w.__poll();await settle();
  assert.equal(s.$('[data-draft="one"]').value,'A real update','real changes still render');
  assert.equal(s.$('[data-comment="one"] .convo-reply').scrollTop,120,'scroll kept across a real update');
});

test('switching Live on and off keeps the agent card intact and shows no error',async t=>{
  const s=await setup(t,[comment('one')]);
  s.data.live={on:false};await s.w.__poll();await settle();
  s.$('#live-switch').focus();s.$('#live-switch').click();await settle();await settle();
  assert.deepEqual(s.calls.at(-1),{path:'/api/live',input:{on:true}});
  assert.ok(s.$('#live-label'),'label survives');assert.ok(s.$('#agent-last'),'last-activity survives');
  assert.notEqual(s.$('#notice').dataset.tone,'fault',s.$('#notice').textContent);
  assert.equal(s.$('#live-switch').disabled,false);assert.equal(s.$('#live-switch').hasAttribute('aria-busy'),false);
  s.data.live={on:true};await s.w.__poll();await settle();
  assert.equal(s.$('#live-label').textContent,'Live On');assert.equal(s.$('#live-switch').getAttribute('aria-checked'),'true');
});

test('the header shows the Page name and exact follower count on every screen',async t=>{
  const s=await setup(t);s.data.facebook.pageName='Wine and Silence';s.data.facebook.followersCount=7763;s.data.facebook.followersUpdatedAt=Date.now();
  await s.w.__poll();await settle();
  assert.equal(s.$('#head-page').textContent,'Wine and Silence');assert.equal(s.$('#head-followers').textContent,'7,763');assert.equal(s.$('#head-followers-label').textContent,'followers');assert.match(s.$('#head-updated').textContent,/Updated/);
  assert.ok(!s.$('.pagebar').closest('.view'),'header sits outside the views, so it shows on every screen');
  s.data.facebook.followersCount=null;await s.w.__poll();await settle();assert.equal(s.$('#head-followers').textContent,'–');assert.equal(s.$('#head-updated').textContent,'');
});

test('owner legacy history transfers to the shared server metric and shows the 24h change',async t=>{
  const s=await setup(t);
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[Date.now()-26*3600e3,7760],[Date.now()-3*3600e3,7761]]));
  s.data.facebook.followersCount=7763;s.data.facebook.followersUpdatedAt=Date.now();s.data.live={on:true};
  await s.w.__poll();await settle();
  assert.equal(s.$('#head-followers').textContent,'7,763');
  assert.equal(s.$('#head-delta').textContent,'+3 in 24h');assert.ok(s.$('#head-delta').classList.contains('up'));
  assert.equal(s.$('#head-trend path.line'),null,'sparse totals cannot invent hourly gains');
  assert.equal(s.$('#head-trend-label').textContent,'Collecting hourly gains');
  assert.equal(s.$('.pagebar').dataset.live,'true');assert.equal(s.$('#head-sync').textContent,'Live on Facebook');
  assert.equal(s.calls.filter(c=>c.path==='/api/facebook/follower-history').length,1,'legacy history transferred once');
  assert.equal(s.data.facebook.followersDelta24h,3);
  assert.equal(s.data.facebook.followersHistoryReady,true);
  s.data.live={on:false};await s.w.__poll();await settle();assert.equal(s.$('#head-sync').textContent,'Paused while Live Off');
});

test('header stays quiet when followers did not change, and shows the Page logo when connected',async t=>{
  const s=await setup(t);
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[Date.now()-5*3600e3,7770]]));
  const end=Math.floor(Date.now()/3600e3)*3600e3;
  s.data.facebook.followersHistoryReady=true;
  s.data.facebook.followersCount=7770;s.data.facebook.followersUpdatedAt=Date.now();s.data.facebook.followersDelta24h=0;s.data.facebook.followersHistory=[[end-3600e3,7770],[end,7770]];s.data.facebook.followersDailyGains=[[end,0]];
  await s.w.__poll();await settle();
  assert.equal(s.$('#head-delta').textContent,'','no "0 in 24h" badge');
  assert.ok(s.$('#head-trend .flat'),'quiet dashed baseline');assert.equal(s.$('#head-trend .line'),null,'no glowing line');
  assert.equal(s.$('#head-logo').hidden,false);assert.equal(s.$('#head-initial').hidden,true);
  s.data.facebook.configured=false;await s.w.__poll();await settle();
  assert.equal(s.$('#head-logo').hidden,true);assert.equal(s.$('#head-initial').textContent,'?');
});


test('hourly gains show slower growth and losses without changing totals for owner or visitor',async t=>{
  for(const guest of [false,true]){
    const s=await setup(t,[],guest),hour=3600e3,now=Date.now(),end=Math.floor(now/hour)*hour;
    Object.assign(s.data.facebook,{followersCount:1140,followersUpdatedAt:now,followersHistoryReady:true,followersDelta24h:140,
      followersHistory:[[end-3*hour,1000],[end-2*hour,1100],[end-hour,1150],[end,1140]]});
    if(guest)s.w.Date.now=()=>now+61000;
    await s.w.__poll();await settle();
    const dots=[...s.w.document.querySelectorAll('#head-trend circle')];
    assert.equal(dots.length,3);
    assert.ok(+dots[0].getAttribute('cy')<+dots[1].getAttribute('cy'));
    assert.ok(+dots[1].getAttribute('cy')<+dots[2].getAttribute('cy'));
    assert.match(dots[0].textContent,/\+100 net followers in 1 hour/);assert.match(dots[1].textContent,/\+50 net followers in 1 hour/);
    assert.match(dots[2].textContent,/-10 net followers in 1 hour/);assert.ok(dots[2].classList.contains('loss'));
    assert.match(dots[2].textContent,/SGT/);assert.match(s.$('#head-trend .line').getAttribute('d'),/C/);
    assert.equal(s.$('#head-trend-label').textContent,'Hourly gains / 24 hours');
    assert.equal(s.$('#head-delta').textContent,'+140 in 24h');assert.equal(s.calls.length,0);
  }
});

test('graph peak and low use Singapore hours and hover, touch and keyboard work in viewer mode',async t=>{
  for(const guest of [false,true]){
    const s=await setup(t,[],guest),hour=3600e3,end=Date.parse('2100-01-02T01:00:00+08:00');
    s.w.Date.now=()=>end+30*60000;
    Object.assign(s.data.facebook,{followersCount:1090,followersUpdatedAt:end,followersHistoryReady:true,
      followersHistory:[[end-2*hour,1000],[end-hour,1100],[end,1090]]});
    await s.w.__poll();await settle();
    const summary=s.$('#head-trend-summary');
    assert.equal(summary.hidden,false);assert.match(summary.textContent,/Peak 11PM\u201312AM/);assert.match(summary.textContent,/Low 12\u20131AM/);
    const hit=s.$('#head-trend [data-trend-hour="22"]'),tooltip=s.$('#head-trend-tooltip');
    hit.dispatchEvent(new s.w.MouseEvent('pointermove',{bubbles:true}));
    assert.equal(tooltip.hidden,false);assert.match(tooltip.textContent,/1 Jan/);assert.match(tooltip.textContent,/SGT/);assert.match(tooltip.textContent,/\+100 net followers/);
    const touch=new s.w.MouseEvent('pointerdown',{bubbles:true});Object.defineProperty(touch,'pointerType',{value:'touch'});hit.dispatchEvent(touch);
    const leave=new s.w.MouseEvent('pointerleave');Object.defineProperty(leave,'pointerType',{value:'touch'});s.$('#head-trend').dispatchEvent(leave);
    assert.equal(tooltip.hidden,false,'tap details persist after lifting a finger');
    s.w.document.body.dispatchEvent(new s.w.MouseEvent('pointerdown',{bubbles:true}));assert.equal(tooltip.hidden,true);
    if(!guest){
      s.$('#head-trend').focus();assert.match(tooltip.textContent,/-10 net followers/);
      s.$('#head-trend').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.match(tooltip.textContent,/\+100 net followers/);
      s.$('#head-trend').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(tooltip.hidden,true);
    }
    assert.equal(s.calls.length,0);
  }
});

test('flat hourly data says steady rather than suggesting a peak, and missing history hides the summary',async t=>{
  const s=await setup(t),hour=3600e3,end=Math.floor(Date.now()/hour)*hour;
  Object.assign(s.data.facebook,{followersCount:1000,followersUpdatedAt:end,followersHistoryReady:true,followersHistory:[[end-2*hour,1000],[end-hour,1000],[end,1000]]});
  await s.w.__poll();assert.equal(s.$('#head-trend-summary').textContent,'Steady 0 / hour');
  s.data.facebook.followersHistory=[];await s.w.__poll();assert.equal(s.$('#head-trend-summary').hidden,true);assert.equal(s.$('#head-trend-tooltip').hidden,true);
});

test('hourly gains exclude unfinished hours, stale boundaries and historical estimates',async t=>{
  const s=await setup(t),hour=3600e3,now=Date.now(),end=Math.floor(now/hour)*hour;
  Object.assign(s.data.facebook,{followersCount:2000,followersUpdatedAt:now,followersHistoryReady:true,
    followersDailyGains:Array.from({length:30},(_,i)=>[end-i*24*hour,500]),
    followersHistory:[[end-5*hour,1000],[end-4*hour,1010],[end-2*hour-16*60000,1050],[end-hour,1100],[end,1120],[end+1,2000]]});
  await s.w.__poll();await settle();
  const path=s.$('#head-trend path.line').getAttribute('d');
  assert.equal((path.match(/M/g)||[]).length,2,'missing hours are gaps');
  assert.equal((path.match(/C/g)||[]).length,0);
  const titles=[...s.w.document.querySelectorAll('#head-trend circle title')].map(p=>p.textContent);
  assert.equal(titles.length,2);assert.match(titles[0],/\+10 net followers/);assert.match(titles[1],/\+20 net followers/);
  assert.equal(s.w.document.querySelectorAll('#head-trend .estimated').length,0);
});

test('visitors land on only automatically published replies with settings locked, including DOM and keyboard bypass attempts',async t=>{
  const s=await setup(t,[comment('auto1','published',{publish_kind:'automatic'}),comment('auto2','published',{publish_kind:'automatic'}),comment('manual','published',{publish_kind:'approved'}),comment('edited','published',{publish_kind:'edited'}),comment('external','published',{publish_kind:'external'}),comment('legacy','published'),comment('private')],true);
  assert.equal(s.w.document.body.dataset.access,'visitor');
  assert.equal(s.$('[data-filter="automatic"]').getAttribute('aria-pressed'),'true');
  assert.equal(s.$('#visitor-access').hidden,false);assert.equal(s.$('#visitor-sign-in').getAttribute('href'),'/login');
  for(const id of ['manual','edited','external','legacy'])assert.equal(s.$('[data-row="'+id+'"]'),null);
  assert.equal(s.$('[data-row="private"]'),null);assert.equal(s.w.__cloudflareRequests,0);
  for(const el of s.w.document.querySelectorAll('button,input,select,textarea'))if(!el.matches('[data-row],[data-back]'))assert.equal(el.disabled,true,el.id);
  s.$('[data-row="auto2"]').click();assert.equal(s.$('[data-comment="auto2"]').hidden,false);
  for(const id of ['open-test','live-switch','verify-fb','save-model','sign-out']){
    const b=s.$('#'+id);b.disabled=false;b.click();
  }
  const filter=s.$('[data-filter="pending"]');filter.disabled=false;filter.click();
  s.$('#rules-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));
  for(const key of ['a','a','r','e'])s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key,bubbles:true}));
  s.w.location.hash='#connections';s.w.dispatchEvent(new s.w.HashChangeEvent('hashchange'));
  await settle();assert.equal(s.$('#connections').hidden,true);assert.equal(s.$('#test-form').hidden,true);
  assert.equal(s.$('[data-filter="automatic"]').getAttribute('aria-pressed'),'true');assert.equal(s.calls.length,0);
  await s.w.__poll();assert.equal(s.calls.length,0);assert.equal(s.w.__cloudflareRequests,0);
});


test('Page age uses elapsed days and the Singapore creation time, hiding unavailable dates',async t=>{
  const s=await setup(t);const created=Date.parse('2026-09-12T14:00:00+08:00');
  s.data.facebook.pageCreatedAt=created;await s.w.__poll();
  assert.equal(s.$('#head-age').hidden,false);
  assert.equal(s.$('#head-age').textContent,'Facebook Page · '+Math.floor((Date.now()-created)/86400e3).toLocaleString()+' days old');
  assert.match(s.$('#head-age').title,/12 Sept 2026|12 Sep 2026/);assert.match(s.$('#head-age').title,/02:00 pm|02:00 PM|2:00 pm|2:00 PM/);
  s.data.facebook.pageCreatedAt=null;await s.w.__poll();assert.equal(s.$('#head-age').hidden,true);
});


test('owner and visitor show the same +590 with conflicting browser-local follower histories',async t=>{
  for(const guest of [false,true]){
    const s=await setup(t,[],guest),now=Date.now();
    s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[now-25*3600e3,8965],[now-1000,8971]]));
    Object.assign(s.data.facebook,{followersCount:8971,followersUpdatedAt:now,followersDelta24h:590,followersHistoryReady:true,followersHistory:[[now-25*3600e3,8381],[now,8971]]});
    if(guest)s.w.Date.now=()=>now+61000;
    await s.w.__poll();await settle();
    assert.equal(s.$('#head-delta').textContent,'+590 in 24h');assert.equal(s.$('#head-trend path.line'),null,'two totals a day apart cannot supply hourly gains');
    assert.equal(s.calls.length,0,'no browser history overrides the shared total');
  }
});

test('a fresh viewer cannot invent a 24h gain from a short local history',async t=>{
  const s=await setup(t,[],true),now=Date.now();
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[now-60000,8965],[now,8971]]));
  Object.assign(s.data.facebook,{followersCount:8971,followersUpdatedAt:now,followersDelta24h:null,followersHistoryReady:false,followersHistory:[[now,8971]]});
  s.w.Date.now=()=>now+61000;await s.w.__poll();await settle();
  assert.equal(s.$('#head-delta').textContent,'');assert.equal(s.calls.length,0);
});


test('short owner history migrates successfully and visitors show the same observed gain',async t=>{
  const s=await setup(t),now=Date.now();
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[now-10*3600e3,8381],[now-60000,8971]]));
  Object.assign(s.data.facebook,{followersCount:8971,followersUpdatedAt:now,followersHistoryReady:false,followersDelta24h:null});
  await s.w.__poll();await settle();
  assert.equal(s.$('#head-delta').textContent,'+590 since tracking');
  assert.equal(s.calls.filter(c=>c.path==='/api/facebook/follower-history').length,1);
  assert.equal(s.data.facebook.followersObservedChange,590);
  s.w.Date.now=()=>now+6*60000;await s.w.__poll();await settle();
  assert.equal(s.calls.filter(c=>c.path==='/api/facebook/follower-history').length,1,'successful transfer is not repeated every five minutes');
  s.data.readOnly=true;await s.w.__poll();await settle();
  assert.equal(s.$('#head-delta').textContent,'+590 since tracking');
});

test('failed follower transfer reports the server error instead of hiding it',async t=>{
  const s=await setup(t),now=Date.now(),fetch=s.w.fetch;
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[now-10*3600e3,8381]]));
  Object.assign(s.data.facebook,{followersCount:8971,followersUpdatedAt:now});
  s.w.fetch=async(path,options)=>path==='/api/facebook/follower-history'?{ok:false,status:400,json:async()=>({error:'Follower history does not match a saved Facebook reading.'})}:fetch(path,options);
  await s.w.__poll();await settle();
  assert.match(s.$('#notice').textContent,/Could not transfer older follower readings/);assert.equal(s.$('#notice').hidden,false);
});
