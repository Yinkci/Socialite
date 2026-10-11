let state, filter='all', loading=false, search='';
const draftEdits=new Map();
const ideaEdits=new Map(),ideaModes=new Map();
let memoryOffset=0,memorySignature='',memoryRequest=0;
const $=s=>document.querySelector(s);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconPaths={"spark":"M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3z","inbox":"M4 4h16v16H4z M4 13h5l2 3h2l2-3h5","sliders":"M4 7h7m4 0h5M4 17h3m4 0h9 M11 4v6 M7 14v6","link":"M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2 M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2","clock":"M12 8v5l3 2 M21 12a9 9 0 11-18 0 9 9 0 0118 0","check":"M5 12l4 4L19 6","arrow":"M7 17L17 7M7 7h10v10","send":"M22 2L9 15M22 2l-7 20-6-7-7-6 20-7z","search":"M21 21l-5-5 M18 10a8 8 0 11-16 0 8 8 0 0116 0","plus":"M12 5v14M5 12h14","alert":"M12 9v4m0 4h.01 M10 4L2 18a1 1 0 001 2h18a1 1 0 001-2L14 4a2 2 0 00-4 0","message":"M21 11a8 8 0 01-8 8H6l-4 3V6a3 3 0 013-3h8a8 8 0 018 8z M7 8h9M7 12h6","shield":"M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z M8 12l3 3 5-6","refresh":"M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0113 1M18 18a8 8 0 01-13-1","close":"M6 6l12 12M6 18L18 6","layers":"M12 3l10 6-10 6L2 9l10-6z M2 14l10 6 10-6"};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name]||iconPaths.spark}"/></svg>`;
const safeUrl=(value,fallback)=>{try{const url=new URL(value);return url.protocol==='https:'?url.href:fallback;}catch{return fallback;}};
const labels={queued:'Queued',generating:'Drafting…',pending:'Awaiting approval',published:'Published',error:'Needs attention',uncertain:'Check Facebook',removed:'Removed',rejected:'Reply dismissed',skipped:'No reply needed',publishing:'Publishing…',simulated:'Test approved'};
const isNewComment=c=>['queued','generating','pending','publishing'].includes(c.status);
const isPublishedFilter=()=>['published','approved','automatic'].includes(filter);
const publicationLabel=c=>c.publish_kind==='automatic'?'Automatically published':['approved','edited'].includes(c.publish_kind)?'Approved by you':'Publication method unavailable';
const needsAttention=c=>!['published','removed','skipped'].includes(c.status)&&(['error','uncertain'].includes(c.status)||['error','uncertain'].includes(c.reaction_status));
const tabLabels={all:'All comments',new:'New comments',pending:'Awaiting approval',published:'All published',approved:'Approved by you',automatic:'Automatically published',error:'Needs attention',rejected:'Dismissed replies',skipped:'No reply needed'};
const matchesTab=(c,key)=>c.status!=='removed'&&!c.cleared_at&&(key==='all'?!['published','rejected','skipped'].includes(c.status):key==='new'?isNewComment(c):key==='error'?needsAttention(c):key==='approved'?c.status==='published'&&['approved','edited'].includes(c.publish_kind):key==='automatic'?c.status==='published'&&c.publish_kind==='automatic':c.status===key);
const date=(at,seconds=false)=>new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{})});
function notice(message,error=false){const n=$('#notice');n.textContent=message;n.classList.toggle('error',error);n.hidden=false;}
async function api(path,input={}) {
  const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(input)});
  if(response.status===401){location.replace('/login');throw new Error('Please sign in.');}
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
async function action(button,fn,message) {
  const original=button.innerHTML;button.disabled=true;button.textContent='Working…';
  try {await fn();if(message)notice(message);await refresh();} catch(error){notice(error.message,true);} finally{button.disabled=button.id==='memory-clear'&&!state.memory?.total;if(button.id==='memory-toggle')button.textContent=(state.memory?.enabled??true)?'Turn learning off':'Turn learning on';else button.innerHTML=original;if(button.id==='clear-comment-history')renderComments();}
}
function nav(){const section=['queue','personality','connections','activity'].includes(location.hash.slice(1))?location.hash.slice(1):'queue';document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==section);document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===section));if(section==='personality'&&state)renderMemory();$('#section-label').textContent={queue:'Comment inbox',personality:'AI personality',connections:'Connections',activity:'Activity'}[section];}
function renderComments() {
  document.querySelectorAll('[data-filter]').forEach(button=>{
    const key=button.dataset.filter,count=state.tabCounts?.[key]??state.comments.filter(c=>matchesTab(c,key)).length;
    button.textContent=`${tabLabels[key]} (${count.toLocaleString()})`;
  });
  const rows=state.comments.filter(c=>matchesTab(c,filter)&&(!search||[c.author,c.message,c.context,c.draft].some(value=>String(value||'').toLowerCase().includes(search))));
  if(isPublishedFilter())rows.sort((a,b)=>(b.published_at||b.created_at)-(a.published_at||a.created_at));
  const clearButton=$('#clear-comment-history');
  clearButton.hidden=!['skipped','rejected'].includes(filter);
  const clearCount=state.clearableCounts?.[filter]??state.comments.filter(c=>c.status===filter&&(c.source==='test'||!c.page_id||c.page_id===state.settings.pageId)).length;
  clearButton.disabled=!clearCount;
  clearButton.textContent=filter==='skipped'?'Clear all no-reply comments':'Clear all dismissed replies';
  clearButton.title=`Clear ${clearCount} conversations from this tab, including those outside your search. Nothing is deleted from Facebook.`;
  const target=$('#comments');
  for(const t of target.querySelectorAll('textarea[data-draft]')) {
    if(t.value!==t.dataset.original) draftEdits.set(t.dataset.draft,{text:t.value,base:t.dataset.original});
  }
  const focused=document.activeElement;
  const focus=focused?.dataset?.draft, ideaFocus=focused?.dataset?.idea, start=focused?.selectionStart, end=focused?.selectionEnd;
  $('#inbox-count').textContent=rows.length+' comment'+(rows.length===1?'':'s');
  target.innerHTML=rows.length?rows.map(c=>{
    const fbUrl='https://www.facebook.com/'+encodeURIComponent(c.post_id||'');
    const postUrl=safeUrl(c.post_url,fbUrl);
    const imageUrl=safeUrl(c.post_image,'');
    const statusIcon=['published','simulated'].includes(c.status)?'check':['error','uncertain'].includes(c.status)?'alert':c.status==='pending'?'clock':'message';
    if(draftEdits.has(c.id)&&(draftEdits.get(c.id).base!==c.draft||!['pending','generating'].includes(c.status)))draftEdits.delete(c.id);
    const grammarOnly=ideaModes.get(c.id)==='grammar';
    const editable=c.status==='pending';
    const posted=['published','simulated'].includes(c.status);
    const replyTitle=c.status==='generating'?'Generating a new reply':posted?(c.source==='test'?'Approved test reply':'Published reply'):editable?'AI reply draft':'Unpublished AI reply';
    const postCaption=c.context||(c.source==='test'?'No post context supplied.':c.post_loaded?'This post has no caption.':'Post caption is not available yet.');
    const commentLink=new URL(postUrl);commentLink.searchParams.set('comment_id',String(c.id).split('_').pop());
    const liked=c.reaction_applied==='LIKE'&&['applied','manual','simulated'].includes(c.reaction_status);
    const likeLabel=liked?(c.source==='test'?'Test Like simulated':'Liked'):c.reaction_status==='applying'?'Applying Like?':c.reaction_error?'Like needs checking':c.like_after_publish?'Like queued':posted?'No Like recorded':['skipped','rejected'].includes(c.status)?'No reply published':'Included with publishing';
    const reactionPanel=`<div class="reaction-panel"><div class="reaction-heading"><strong>Like on this comment</strong><span>${likeLabel}</span></div><p class="reaction-hint">${liked?(c.source==='test'?'Reply and Like were simulated. Nothing was posted to Facebook.':'Like applied with the published reply.'):c.reaction_error?'Your reply remains published. Check the Like on Facebook; the reply will not be sent again.':posted?(c.like_after_publish?'The reply was published; its Like is being applied.':'This older reply has no recorded automatic Like.'):['skipped','rejected'].includes(c.status)?'A Like is applied only if you publish a reply.':'Publishing this reply also applies a Like. No separate approval is needed.'}</p>${c.reaction_error?`<p class="error-text">${esc(c.reaction_error)}</p>`:''}${c.reaction_error&&c.source==='facebook'?`<a class="post-preview" href="${esc(commentLink.href)}" target="_blank" rel="noopener noreferrer">Check comment on Facebook ${icon('arrow')}</a>`:''}</div>`;
    const controls=`${['queued','pending','error'].includes(c.status)?`<button class="button danger" data-action="reject">Dismiss reply</button><button class="button" data-action="draft">${icon(c.draft?'refresh':'spark')}${c.draft?'Regenerate reply':'Generate reply'}</button>`:''}${['rejected','skipped'].includes(c.status)?`<button class="button" data-action="draft">${icon('refresh')}Generate new reply</button>`:''}${editable?`<button class="button primary" data-action="approve">${icon('send')}${c.source==='test'?'Approve test reply':'Approve & publish reply'}</button>`:''}${c.status==='uncertain'?'<button class="button" data-action="resolve-published">I checked: reply was posted</button><button class="button" data-action="resolve-pending">I checked: no reply was posted</button>':''}`;
    return `<article class="comment-card" data-comment="${esc(c.id)}" aria-label="Conversation with ${esc(c.author||'Facebook user')}">
      <div class="comment-top"><span class="conversation-source">${icon(c.source==='test'?'shield':'message')}${c.source==='test'?'Test conversation':'Facebook conversation'}</span><time datetime="${new Date(c.created_at).toISOString()}">Received: ${date(c.created_at,true)}</time><span class="badge ${esc(c.status)}">${icon(statusIcon)}${c.status==='published'?'Published'+(c.publish_kind?' &middot; '+publicationLabel(c):''):labels[c.status]||esc(c.status)}</span></div>
      <div class="conversation-grid">
        <aside class="post-section" aria-label="Post context"><div class="content-heading"><span class="step-number">1</span><h3>${c.source==='test'?'Test post context':'Your Facebook post / Reel'}</h3></div>
        ${imageUrl&&c.source==='facebook'?`<a href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer"><img class="post-image" src="${esc(imageUrl)}" alt="Facebook post preview" loading="lazy"></a>`:''}
        <div class="post-caption">${esc(postCaption)}</div>
        ${c.source==='facebook'?`<a class="post-preview" href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer">Open post on Facebook ${icon('arrow')}</a>`:'<span class="test-label">Local test · Nothing posts to Facebook</span>'}</aside>
        <div class="conversation-body"><section class="customer-section" aria-label="Customer comment"><div class="content-heading"><span class="step-number">2</span><h3>Customer comment</h3></div><div class="customer-identity"><span class="customer-avatar">${esc((c.author||'F').slice(0,1).toUpperCase())}</span><strong>${esc(c.author||'Facebook user')}</strong><span>said</span></div><blockquote class="comment-message">${esc(c.message)}</blockquote>${reactionPanel}</section>
        <section class="reply-section ${posted?'reply-posted':''}" aria-label="${replyTitle}"><div class="content-heading"><span class="step-number">3</span><h3>${c.draft?replyTitle:'Your reply'}</h3><span class="reply-state">${c.status==='generating'?'Generating&hellip;':posted?'Sent':editable?'Not published':'Not sent'}</span></div>
        ${c.source==='facebook'&&['queued','generating','pending'].includes(c.status)&&c.created_at+(state.settings.commentDelaySeconds||0)*1000>Date.now()?`<p class="review-reason"><strong>Minimum comment delay:</strong> This reply can publish after ${date(c.created_at+state.settings.commentDelaySeconds*1000,true)}. Drafting and editing can happen now.</p>`:''}
        ${c.status==='published'?`<p class="publication-detail">${publicationLabel(c)}${c.published_at?' &middot; Published at '+date(c.published_at,true):''}${c.publish_kind==='edited'?' &middot; You edited this reply before approving.':''}</p>`:''}
        ${c.status==='skipped'?`<p class="review-reason"><strong>No reply needed:</strong> ${esc(c.reason||'This comment has no clear message to respond to.')} No reply will be published. You can reassess it manually; any restored draft will wait for your approval.</p>`:''}
        ${c.status==='pending'&&c.reply_decision==='REVIEW'?'<p class="review-reason"><strong>Meaning needs review:</strong> This reply needs your approval, including in Automatic mode.</p>':''}
        ${c.status==='rejected'?'<p class="dismissed-explanation">This reply was dismissed. You can generate a new reply whenever you want; it will wait for your approval.</p>':''}
        ${c.draft?`<div class="draft">${c.status==='generating'?'<p class="editor-guidance">AI is working on your reply. The previous draft is shown until it is ready.</p>':''}${editable?'<p class="editor-guidance">Edit your reply below, then approve it to publish.</p>':''}<textarea aria-label="Reply to ${esc(c.author)}" data-draft="${esc(c.id)}" data-original="${esc(c.draft)}" rows="3" maxlength="1000" ${editable?'':'readonly'}>${esc(editable?(draftEdits.get(c.id)?.text??c.draft):c.draft)}</textarea>${c.reason?`<p class="review-reason"><strong>Review note:</strong> ${esc(c.reason)}</p>`:''}</div>`:`<p class="reply-placeholder">${c.status==='generating'?'AI is writing a reply. It will appear here shortly.':c.status==='queued'?(state.chatgpt.enabled?'Waiting for automatic drafting. Replies are generated one at a time.':'Connect your Hugging Face Space to generate this reply automatically.'):'No reply has been generated for this comment.'}</p>`}
        ${['queued','pending','error','rejected','skipped','generating'].includes(c.status)?`<div class="ai-direction"><label for="idea-${esc(c.id)}">Work on this reply with AI</label><p>${grammarOnly?'Paste your reply below. AI will only correct spelling, grammar, and punctuation, preserving your meaning and tone.':'Share your idea or tell the AI what to change. It will use this comment, the post, and your current draft.'}</p><label class="idea-mode-label">What should AI do?<select data-idea-mode="${esc(c.id)}" aria-label="AI editing mode for ${esc(c.author)}" ${c.status==='generating'?'disabled':''}><option value="improve" ${!grammarOnly?'selected':''}>Improve my idea</option><option value="grammar" ${grammarOnly?'selected':''}>Correct grammar only</option></select></label><textarea id="idea-${esc(c.id)}" data-idea="${esc(c.id)}" aria-label="Your idea for replying to ${esc(c.author)}" rows="2" maxlength="${grammarOnly?1000:2000}" placeholder="${grammarOnly?'Type the exact reply you want corrected.':'For example: Say I appreciate their support, but make it sound more personal.'}" ${c.status==='generating'?'disabled':''}>${esc(ideaEdits.get(c.id)||'')}</textarea><div class="ai-direction-footer"><span>Creates a draft for your approval.</span><button class="button" data-action="refine" ${c.status==='generating'?'disabled':''}>${icon('spark')}${grammarOnly?'Correct grammar':'Write reply from my idea'}</button></div></div>`:''}
        ${c.error?`<p class="error-text"><strong>Needs attention:</strong> ${esc(c.error)}</p>`:''}
        ${controls?`<div class="comment-actions">${controls}</div>`:''}</section></div>
      </div></article>`;
  }).join(''):`<div class="empty"><div class="empty-symbol">${icon(search?'search':'inbox')}</div><h2>${search?'No matching conversations.':filter==='all'?'A fresh start for your conversations.':'You are all caught up.'}</h2><p>${search?'Try another name, comment, or phrase.':filter==='all'?'New comments will arrive here. Try a test comment to hear your assistant in action.':'New conversations matching this filter will appear here.'}</p><button id="empty-test" class="button quiet">${icon('plus')}Try a test comment</button></div>`;
  if(ideaFocus){const t=[...target.querySelectorAll('textarea[data-idea]')].find(t=>t.dataset.idea===ideaFocus);if(t&&!t.disabled){t.focus({preventScroll:true});t.setSelectionRange(start,end);}}
  if(focus){const t=[...target.querySelectorAll('textarea')].find(t=>t.dataset.draft===focus);if(t){t.focus({preventScroll:true});t.setSelectionRange(start,end);}}
}
function render(){
  $('#header-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
  const replyAI=state.replyAI||{provider:'huggingface',enabled:false};
  $('#rail-ai-status').textContent=replyAI.enabled?'ZeroGPU Space':'Not connected';
  $('#rail-ai-dot').classList.toggle('connected',replyAI.enabled);
  $('#provider-status').textContent=replyAI.enabled?'Connected':'Not ready';
  $('#local-saved').textContent=replyAI.enabled?'Connected to Space '+state.settings.hfSpace:'Add your Space and access token, then save.';
  $('#local-saved').className='status-line '+(replyAI.enabled?'ok':'bad');
  const pageLabel=state.facebook.configured?(state.facebook.pageName||'Page '+state.settings.pageId):'Not configured';
  $('#rail-fb-status').textContent=pageLabel;
  $('#rail-fb-status').title=state.facebook.configured?'Facebook Page ID: '+state.settings.pageId:'';
  $('#rail-fb-dot').classList.toggle('connected',state.facebook.configured);
  const followers=state.facebook.followersCount, hasFollowers=state.facebook.configured&&Number.isSafeInteger(followers)&&followers>=0;
  $('#rail-fb-followers').hidden=!state.facebook.configured;
  $('#rail-fb-followers').textContent=hasFollowers?followers.toLocaleString()+' '+(followers===1?'follower':'followers'):'Followers unavailable';
  const updated=state.facebook.followersUpdatedAt;
  $('#rail-fb-updated').hidden=!hasFollowers||!updated;
  $('#rail-fb-updated').textContent=updated?'Updated '+new Date(updated).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'';
  $('#rail-fb-updated').title=updated?'Last fetched: '+new Date(updated).toLocaleString()+'. Refreshes every 5 minutes. Verify Page in Connections to refresh now.':'';
  const newCount=state.comments.filter(isNewComment).length;
  $('#stat-new').textContent=newCount.toLocaleString();
  const openCount=state.comments.filter(c=>isNewComment(c)||needsAttention(c)).length;
  $('#nav-count').textContent=openCount.toLocaleString();
  $('#nav-count').title=openCount+' open comments, including those waiting for an AI draft';
  $('#stat-pending').textContent=state.comments.filter(c=>c.status==='pending').length;
  $('#stat-published').textContent=state.comments.filter(c=>c.status==='published').length;
  $('#stat-errors').textContent=state.comments.filter(needsAttention).length;
  $('#mode-label').textContent={approval:'Approval required',hybrid:'Hybrid publishing',automatic:'Automatic publishing'}[state.settings.mode];
  $('#connection-banner').hidden=replyAI.enabled&&state.facebook.configured;
  $('#fb-status').textContent=state.facebook.configured?(pageLabel+(state.facebook.hasAppSecret?'':' - App secret needed')):'Not configured';
  $('#webhook-address').value=state.webhookUrl;
  const live=state.live||{}, webhookHere=live.on&&live.receiving;
  $('#webhook-status').textContent=live.on?'Live On':'Live Off';
  $('#webhook-line').textContent=webhookHere?'New comments arrive here.':live.on?'Connecting… comments will arrive here shortly.':live.target?'Live Off. Comments currently go to your other Socialite app.':'Live Off. Comments are not received.';
  $('#webhook-line').className='status-line '+(webhookHere?'ok':live.on?'busy':'idle');
  $('#connect-webhook').textContent=live.on?'Turn Live Off':'Turn Live On';
  $('#connect-webhook').className='button '+(live.on?'quiet':'primary');
  $('#verify-token').value=state.facebook.verifyToken;
  $('#activity-list').innerHTML=state.activity.length?state.activity.map(a=>`<div class="activity-row"><time>${date(a.at)}</time><span>${esc(a.message)}</span></div>`).join(''):'<p>Workspace activity will appear here.</p>';
  renderComments();renderMemory();renderLive();
}
function renderMemory(){
  const m=state.memory||{enabled:true,total:0,counts:{},summary:null,revision:'0'};
  $('#memory-toggle').textContent=m.enabled?'Turn learning off':'Turn learning on';
  $('#memory-status').textContent=(m.enabled?'Learning is on. ':'Learning is off. ')+m.total+' published '+(m.total===1?'example':'examples')+' saved for this Page.';
  const p=m.summary;
  $('#memory-summary').textContent=p?`Learned style: about ${p.weighted_average_characters} characters per reply; emojis in ${p.replies_with_emoji_percent}% of replies. ${m.counts.edited||0} edited, ${m.counts.approved||0} personally approved, ${m.counts.automatic||0} automatic, ${m.counts.historical||0} historical. Recalculated from saved examples.`:'Your voice memory starts with verified published replies. New approved replies build it over time.';
  $('#memory-clear').disabled=!m.total;
  if($('#personality').hidden)return;
  if(memoryOffset>=m.total)memoryOffset=Math.max(0,Math.floor((m.total-1)/20)*20);
  const signature=state.settings.pageId+':'+m.revision+':'+memoryOffset;
  if(signature===memorySignature)return;memorySignature=signature;
  const request=++memoryRequest;
  $('#memory-list').textContent='Loading published examples...';
  fetch('/api/memory?offset='+memoryOffset).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||'Cannot load reply memory');return data;}).then(data=>{
    if(request!==memoryRequest)return;
    const names={edited:'Edited by you',approved:'Approved by you',automatic:'Published automatically',historical:'Historical published reply'};
    $('#memory-list').innerHTML=data.rows.length?data.rows.map(r=>`<details class="memory-example"><summary><span>${esc(r.reply)}</span><small>${esc(names[r.kind]||'Published reply')} &middot; ${date(r.published_at)}</small></summary><div class="memory-example-body"><strong>Customer comment</strong><p>${esc(r.comment)}</p><strong>Post context</strong><p>${esc(r.post||'No caption recorded.')}</p><strong>Published reply</strong><p>${esc(r.reply)}</p><button type="button" class="button danger" data-memory-delete="${esc(r.comment_id)}">Forget this example</button></div></details>`).join(''):'<p class="hint">No saved examples yet. Test comments, dismissed drafts, and unconfirmed posting attempts are never used for learning.</p>';
    $('#memory-page').textContent=data.total?`${data.offset+1}-${Math.min(data.offset+20,data.total)} of ${data.total}`:'0 examples';
    $('#memory-prev').disabled=data.offset===0;$('#memory-next').disabled=data.offset+20>=data.total;
  }).catch(error=>{if(request!==memoryRequest)return;memorySignature='';$('#memory-list').textContent=error.message;});
}
$('#memory-toggle').onclick=()=>action($('#memory-toggle'),async()=>{await api('settings',{learningEnabled:!(state.memory?.enabled??true)});},'Reply learning preference saved.');
$('#memory-clear').onclick=()=>action($('#memory-clear'),async()=>{await api('memory/clear');memoryOffset=0;memorySignature='';},"This Page's reply memory was cleared. Published comments remain intact.");
$('#memory-list').addEventListener('click',event=>{const b=event.target.closest('[data-memory-delete]');if(b)action(b,async()=>{await api('memory/delete',{id:b.dataset.memoryDelete});memorySignature='';},'Example forgotten.');});
$('#memory-prev').onclick=()=>{memoryOffset=Math.max(0,memoryOffset-20);renderMemory();};
$('#memory-next').onclick=()=>{memoryOffset+=20;renderMemory();};
async function refresh(initial=false){if(loading)return;loading=true;try{state=await fetch('/api/state').then(r=>{if(r.status===401){location.replace('/login');throw new Error('Please sign in.');}if(!r.ok)throw new Error('Cannot load dashboard');return r.json();});render();if(initial){for(const [id,key] of [['personality-input','personality'],['knowledge-input','knowledge'],['examples-input','examples'],['reply-policy-input','replyPolicy'],['mode-input','mode'],['interval-input','intervalSeconds'],['comment-delay-input','commentDelaySeconds'],['posts-input','postIds'],['page-input','pageId'],['version-input','graphVersion']])$('#'+id).value=key==='replyPolicy'&&state.settings.replyPolicyPageId!==state.settings.pageId?'':state.settings[key]??'';$('#skip-emoji-input').checked=state.settings.replyPolicyPageId===state.settings.pageId&&!!state.settings.skipEmojiOnly;fillReplyAI();}}finally{loading=false;}}
function showTest(){$('#test-form').hidden=false;$('#test-form').scrollIntoView({behavior:'smooth'});}
window.addEventListener('hashchange',nav);nav();
$('#open-test').onclick=showTest;$('#close-test').onclick=()=>$('#test-form').hidden=true;
$('#comments').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.id==='empty-test')return showTest();
  const card=button.closest('[data-comment]');if(!card)return;
  const id=card.dataset.comment,kind=button.dataset.action;
  action(button,async()=>{
    if(kind.startsWith('resolve-'))await api('resolve-uncertain',{id,status:kind.slice(8)});
    else if(kind==='refine'){const instructions=card.querySelector('[data-idea]').value.trim();if(!instructions)throw new Error('Write your idea or instructions first.');await api('draft',{id,draft:card.querySelector('[data-draft]')?.value,instructions,editingMode:ideaModes.get(id)||'improve'});}
    else await api(kind,{id,draft:card.querySelector('[data-draft]')?.value});
    draftEdits.delete(id);
    const editor=[...document.querySelectorAll('textarea[data-draft]')].find(t=>t.dataset.draft===id);
    if(editor)editor.value=editor.dataset.original;
  },kind==='approve'?'Reply handled. Check its status in the inbox.':['draft','refine'].includes(kind)?'Drafting finished. Check the comment for its reply or error.':'Comment updated.');
});
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});renderComments();});
$('#show-new-comments').onclick=()=>{search='';$('#comment-search').value='';location.hash='#queue';nav();$('[data-filter="new"]').click();$('#comments').scrollIntoView({behavior:'smooth',block:'start'});};
$('#clear-comment-history').onclick=()=>{
  const status=filter;if(!['skipped','rejected'].includes(status))return;
  action($('#clear-comment-history'),async()=>{const result=await api('comments/clear',{status});notice(`${result.cleared} ${status==='skipped'?'no-reply comments':'dismissed replies'} cleared from local history.`);});
};
$('#comment-search').addEventListener('input',event=>{search=event.target.value.toLowerCase().trim();renderComments();});
$('#comments').addEventListener('change',async event=>{
  const select=event.target;
  if(select.matches('select[data-idea-mode]')){ideaModes.set(select.dataset.ideaMode,select.value);renderComments();const replacement=[...document.querySelectorAll('[data-idea-mode]')].find(s=>s.dataset.ideaMode===select.dataset.ideaMode);replacement?.focus({preventScroll:true});return;}

});
$('#comments').addEventListener('input',event=>{const t=event.target;if(t.matches('textarea[data-idea]'))ideaEdits.set(t.dataset.idea,t.value);if(t.matches('textarea[data-draft]')){if(t.value===t.dataset.original)draftEdits.delete(t.dataset.draft);else draftEdits.set(t.dataset.draft,{text:t.value,base:t.dataset.original});}});
$('#personality-form').onsubmit=event=>{event.preventDefault();action(event.submitter,()=>api('settings',{...Object.fromEntries(new FormData(event.target)),skipEmojiOnly:event.target.elements.skipEmojiOnly.checked}),'Personality saved. New drafts will use these instructions.');};
$('#rules-form').onsubmit=event=>{event.preventDefault();action(event.submitter,()=>api('settings',Object.fromEntries(new FormData(event.target))),'Publishing preferences saved.');};
$('#test-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('test-comment',Object.fromEntries(new FormData(event.target)));event.target.reset();},'Test comment added. The AI will draft a reply automatically when your Hugging Face Space is connected.');};
$('#facebook-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('facebook/save',Object.fromEntries(new FormData(event.target)));event.target.elements.pageToken.value='';event.target.elements.appSecret.value='';},'Facebook settings saved. Verify the Page connection before publishing.');};
$('#verify-fb').onclick=()=>action($('#verify-fb'),async()=>{const page=await api('facebook/verify');notice('Verified Facebook Page: '+page.name);});
$('#subscribe-fb').onclick=()=>action($('#subscribe-fb'),()=>api('facebook/subscribe'),'Page subscribed. Finish configuring the feed webhook in Meta.');
$('#copy-token').onclick=()=>action($('#copy-token'),()=>navigator.clipboard.writeText($('#verify-token').value),'Verify token copied.');
// Live On/Off: only one Socialite app (this PC or Cloudflare) works at a time.
function renderLive(){
  const live=state.live||{on:false}, sw=$('#live-switch');
  sw.setAttribute('aria-checked',String(live.on));sw.classList.toggle('on',live.on);
  $('#live-label').textContent=live.on?'Live On':'Live Off';
  $('#live-banner').hidden=live.on;
  const elsewhere=live.target&&!live.receiving;
  $('#live-banner-text').textContent='Nothing is drafted, posted or liked here, and new comments are not received.'+(elsewhere?' Comments currently go to your other Socialite app.':'');
}
async function setLive(on){
  const button=document.activeElement?.closest?.('button')||(on?$('#live-banner-on'):$('#live-switch'));
  await action(button,()=>api('live',{on}),on?'Live On. Comments now come to this app. The other Socialite app switches itself off within a minute.':'Live Off. Drafting, posting and Likes are stopped.');
}
$('#live-switch').onclick=()=>setLive(!(state.live?.on));
$('#live-banner-on').onclick=()=>setLive(true);
await refresh(true).catch(error=>notice(error.message,true));
function fillReplyAI(){
  $('#hf-space-input').value=state.settings.hfSpace||'';
}
$('#check-hf').onclick=()=>action($('#check-hf'),async()=>{
  await api('settings',Object.fromEntries(new FormData($('#ai-provider-form'))));$('#hf-token-input').value='';
  await api('huggingface/check');
},'Your Hugging Face Space is connected and ready.');
$('#ai-provider-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('settings',Object.fromEntries(new FormData(event.target)));$('#hf-token-input').value='';},'Reply AI saved. New drafts will use your Space.');};
$('#connect-webhook').onclick=()=>setLive(!(state.live?.on));
$('#copy-webhook').onclick=()=>action($('#copy-webhook'),()=>navigator.clipboard.writeText($('#webhook-address').value),'Webhook address copied.');
$('#password-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('password',Object.fromEntries(new FormData(event.target)));location.replace('/login');});};
$('#sign-out').onclick=async()=>{await fetch('/api/logout',{method:'POST'}).catch(()=>{});location.replace('/login');};
setInterval(()=>refresh().catch(()=>notice('Cannot reach Socialite. Check your internet connection.',true)),5000);
