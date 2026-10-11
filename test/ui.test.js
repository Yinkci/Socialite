import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html=readFileSync('public/index.html','utf8');
const script=readFileSync('public/app.js','utf8').replace('await refresh(true).catch(error=>notice(error.message,true));','window.__ready=refresh(true).catch(error=>notice(error.message,true));');
const comment=(id,status='pending',extra={})=>({id,author:'Alex',source:'facebook',post_id:'123_456',post_url:'https://www.facebook.com/123_456',post_loaded:1,created_at:Date.now(),message:'Love this product!',context:'A new launch',draft:'Thank you for the support!',review:0,reason:'',error:'',status,...extra});
async function setup(t,comments=[]) {
  const data={csrf:'test-csrf',settings:{personality:'Warm and helpful',knowledge:'Our FAQs',examples:'Thanks!',model:'',mode:'approval',pageId:'123',graphVersion:'v26.0',postIds:'',intervalSeconds:30},replyAI:{provider:'huggingface',enabled:true},huggingface:{hasToken:true},live:{on:true,receiving:true},facebook:{configured:true,hasAppSecret:true,verifyToken:'test-verify'},webhookUrl:'https://socialite.example.workers.dev/webhooks/facebook',memory:{enabled:true,total:0,counts:{},summary:null,revision:'0'},comments,activity:[{at:Date.now(),message:'Draft ready for Alex.'}]};
  const dom=new JSDOM(html,{url:'http://127.0.0.1:8787',runScripts:'outside-only'});
  const w=dom.window, calls=[];
  w.setInterval=fn=>{w.__poll=fn;};
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.fetch=async(path,options)=>{
    if(path.startsWith('/api/memory?')){const offset=Number(new URL(path,'http://127.0.0.1:8787').searchParams.get('offset'));const rows=w.__memoryRows||[];return {ok:true,json:async()=>({offset,total:rows.length,rows:rows.slice(offset,offset+20)})};}
    if(path==='/api/state') return {ok:true,json:async()=>structuredClone(data)};
    const input=JSON.parse(options.body);calls.push({path,input});
    if(path==='/api/settings'&&'learningEnabled' in input)data.memory.enabled=input.learningEnabled;
    if(path==='/api/memory/delete'){w.__memoryRows=w.__memoryRows.filter(r=>r.comment_id!==input.id);data.memory.total=w.__memoryRows.length;data.memory.revision+='x';}
    if(path==='/api/memory/clear'){w.__memoryRows=[];data.memory.total=0;data.memory.revision+='x';}
    if(path==='/api/approve'){const c=data.comments.find(c=>c.id===input.id);c.status='published';c.reaction_applied='LIKE';c.reaction_status='applied';}
    if(path==='/api/draft'){const c=data.comments.find(c=>c.id===input.id);c.status='generating';if(w.__draftGate)await w.__draftGate;c.draft='A fresh generated reply.';c.status='pending';}
    if(path==='/api/comments/clear'){const removed=data.comments.filter(c=>c.status===input.status).length;data.comments=data.comments.filter(c=>c.status!==input.status);return {ok:true,json:async()=>({ok:true,cleared:removed})};}
    if(path==='/api/reject'){data.comments.find(c=>c.id===input.id).status='rejected';}
    return {ok:true,json:async()=>({ok:true})};
  };
  w.eval(script);await w.__ready;
  t.after(()=>w.close());
  return {w,data,calls,$:s=>w.document.querySelector(s),input:(element,value)=>{element.value=value;element.dispatchEvent(new w.Event('input',{bubbles:true}));}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('redesigned dashboard loads all panels and preserves connection inputs',async t=>{
  const s=await setup(t,[comment('one'),comment('two','published'),comment('three','error')]);
  assert.equal(s.$('#notice').hidden,true);assert.equal(s.$('#pause'),null);
  assert.equal(s.$('#stat-pending').textContent,'1');assert.equal(s.$('#stat-published').textContent,'1');
  assert.equal(s.$('#rail-ai-status').textContent,'ZeroGPU Space');assert.equal(s.$('#webhook-address').value,'https://socialite.example.workers.dev/webhooks/facebook');assert.equal(s.$('#rail-fb-status').textContent,'Page 123');
  assert.equal(s.$('#personality-input').value,'Warm and helpful');assert.equal(s.$('#page-input').value,'123');
  assert.equal(s.$('input[name="pageToken"]').type,'password');assert.equal(s.$('input[name="appSecret"]').type,'password');
  const ids=[...s.w.document.querySelectorAll('[id]')].map(e=>e.id);assert.equal(new Set(ids).size,ids.length);
});
test('search matches comment, author, post caption, and reply text',async t=>{
  const s=await setup(t,[comment('one'),comment('two','pending',{author:'Sam',message:'Shipping question',context:'Summer collection',draft:'Delivery takes three days.'})]);
  for(const query of ['Sam','shipping','summer','three days']) {s.input(s.$('#comment-search'),query);assert.equal(s.w.document.querySelectorAll('.convo').length,1);assert.equal(s.$('.convo').dataset.comment,'two');}
  s.input(s.$('#comment-search'),'not found');assert.match(s.$('#comments').textContent,/No matching/);
});
test('unsaved draft survives filtering, search, and polling',async t=>{
  const s=await setup(t,[comment('one'),comment('two','published')]);
  s.input(s.$('[data-draft="one"]'),'My edited reply');
  s.$('[data-filter="published"]').click();s.$('[data-filter="all"]').click();
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
  assert.equal(card('test').querySelector('.convo-reply h3').textContent,'Approved test reply');
  assert.match(card('waiting').querySelector('.empty-reply').textContent,/AI is writing/);
  assert.equal(card('waiting').querySelector('[data-action="approve"]'),null);
  s.$('[data-filter="rejected"]').click();assert.equal(card('discarded').querySelector('.reply-flag').textContent,'Not sent');assert.equal(card('discarded').querySelector('[data-draft]').readOnly,true);
});

test('published conversations stay out of All comments, including searches and polling, but remain in Published',async t=>{
  const s=await setup(t,[comment('pending'),comment('sent','published',{author:'Published person'}),comment('error','error')]);
  assert.equal(s.$('[data-comment="sent"]'),null);assert.equal(s.$('#inbox-count').textContent,'2 comments');
  s.input(s.$('#comment-search'),'Published person');assert.equal(s.$('.convo'),null);
  s.$('[data-filter="published"]').click();assert.ok(s.$('[data-comment="sent"]'));
  s.input(s.$('#comment-search'),'');s.$('[data-filter="all"]').click();await s.w.__poll();await settle();assert.equal(s.$('[data-comment="sent"]'),null);
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
  s.$('[data-action="draft"]').click();await settle();s.$('[data-filter="all"]').click();
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
  s.$('[data-filter="published"]').click();s.$('[data-filter="all"]').click();
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
  s.$('[data-filter="published"]').click();s.$('[data-filter="all"]').click();await s.w.__poll();await settle();
  assert.equal(s.$('[data-idea-mode="one"]').value,'grammar');assert.equal(s.$('[data-idea="one"]').value,'I appreciates your support!');
  s.$('[data-action="refine"]').click();await settle();
  assert.equal(s.calls[0].input.editingMode,'grammar');assert.equal(s.calls[0].input.instructions,'I appreciates your support!');
  assert.equal(s.$('[data-idea="one"]').value,'I appreciates your support!');assert.ok(s.$('[data-action="approve"]'));
});


test('new comments are visible before drafting, update while polling, and can be opened from the overview',async t=>{
  const s=await setup(t,[comment('queued','queued',{draft:''}),comment('drafting','generating',{draft:''}),comment('ready'),comment('sent','published'),comment('dismissed','rejected'),comment('removed','removed'),comment('error','error')]);
  assert.equal(s.$('#stat-new').textContent,'3');assert.equal(s.$('#nav-count').textContent,'4');
  s.input(s.$('#comment-search'),'not found');s.$('#show-new-comments').click();
  assert.equal(s.$('#comment-search').value,'');assert.equal(s.w.document.querySelectorAll('.convo').length,3);
  assert.equal(s.$('[data-filter="new"]').getAttribute('aria-pressed'),'true');
  s.data.comments.find(c=>c.id==='queued').status='published';await s.w.__poll();await settle();assert.equal(s.$('#stat-new').textContent,'2');
  s.data.comments.push(comment('incoming','queued',{draft:''}));await s.w.__poll();await settle();assert.equal(s.$('#stat-new').textContent,'3');assert.ok(s.$('[data-comment="incoming"]'));
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
  s.$('[data-filter="all"]').click();assert.equal(s.$('[data-comment="auto-new"]'),null);
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
  const expected={all:3,new:2,pending:1,published:3,approved:1,automatic:1,error:1,rejected:1,skipped:1};
  for(const [key,n] of Object.entries(expected))assert.match(s.$(`[data-filter="${key}"]`).textContent,new RegExp('\\('+n+'\\)$'));
  s.input(s.$('#comment-search'),'no matching text');assert.match(s.$('[data-filter="skipped"]').textContent,/\(1\)$/);
  s.data.comments.find(c=>c.id==='queued').status='pending';await s.w.__poll();await settle();assert.match(s.$('[data-filter="pending"]').textContent,/\(2\)$/);
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

test('extra filters live in a menu and the command palette runs commands',async t=>{
  const s=await setup(t,[comment('one'),comment('skip','skipped')]);
  s.$('#filter-more').click();assert.equal(s.$('#filter-menu').hidden,false);
  s.$('[data-filter="skipped"]').click();assert.equal(s.$('#filter-menu').hidden,true);assert.equal(s.$('#filter-more-label').textContent,'No reply');
  assert.ok(s.$('[data-comment="skip"]'));
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));assert.equal(s.$('#palette').hidden,false);
  s.input(s.$('#palette-input'),'connections');s.$('#palette-input').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();
  assert.equal(s.$('#palette').hidden,true);assert.equal(s.w.location.hash,'#connections');
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

test('header trend: follower history is kept in the browser and shows the 24h change',async t=>{
  const s=await setup(t);
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[Date.now()-26*3600e3,7760],[Date.now()-3*3600e3,7761]]));
  s.data.facebook.followersCount=7763;s.data.facebook.followersUpdatedAt=Date.now();s.data.live={on:true};
  await s.w.__poll();await settle();
  assert.equal(s.$('#head-followers').textContent,'7,763');
  assert.equal(s.$('#head-delta').textContent,'+3 in 24h');assert.ok(s.$('#head-delta').classList.contains('up'));
  assert.ok(s.$('#head-trend path.line'),'trend line drawn');
  assert.equal(s.$('.pagebar').dataset.live,'true');assert.equal(s.$('#head-sync').textContent,'Live on Facebook');
  assert.equal(JSON.parse(s.w.localStorage.getItem('socialite:followers:123')).length,3,'new reading saved');
  s.data.live={on:false};await s.w.__poll();await settle();assert.equal(s.$('#head-sync').textContent,'Paused while Live Off');
});

test('header stays quiet when followers did not change, and shows the Page logo when connected',async t=>{
  const s=await setup(t);
  s.w.localStorage.setItem('socialite:followers:123',JSON.stringify([[Date.now()-5*3600e3,7770]]));
  s.data.facebook.followersCount=7770;s.data.facebook.followersUpdatedAt=Date.now();
  await s.w.__poll();await settle();
  assert.equal(s.$('#head-delta').textContent,'','no "0 in 24h" badge');
  assert.ok(s.$('#head-trend .flat'),'quiet dashed baseline');assert.equal(s.$('#head-trend .line'),null,'no glowing line');
  assert.equal(s.$('#head-logo').hidden,false);assert.equal(s.$('#head-initial').hidden,true);
  s.data.facebook.configured=false;await s.w.__poll();await settle();
  assert.equal(s.$('#head-logo').hidden,true);assert.equal(s.$('#head-initial').textContent,'?');
});
