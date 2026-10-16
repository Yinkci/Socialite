let state, filter='new', loading=false, search='', selected=null;
let stateETag='',pollRetryAt=0,visitorMode=false,visitorNextAt=0;
let cloudflareUsage=null,cloudflareNextAt=0,cloudflareLoading=false;
let earningsNextAt=0,earningsLoading=false,earningsPage='';
const draftEdits=new Map();
const ideaEdits=new Map(),ideaModes=new Map();
let memoryOffset=0,memorySignature='',memoryRequest=0;
const $=s=>document.querySelector(s);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 16px line icons.
const iconPaths={msg:'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',flask:'M6 2h4M6.5 2v4L3 13h10L9.5 6V2',check:'m3 8.5 3 3 7-7',alert:'M8 2.5 14 13H2zM8 6.5v3M8 11.5v.01',wait:'M8 4v4l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0',ext:'M9.5 2.5h4v4M13.5 2.5 7 9M12 9.5v4H2.5V4h4',send:'m2 8 12-5.5L10.5 14 8 9.5z',again:'M13.5 7.5A5.5 5.5 0 1 1 11.8 4M13.5 2v3.5H10',spark:'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2',back:'M10 3 5 8l5 5',dot:'M8 8h.01'};
const icon=name=>`<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="${iconPaths[name]||iconPaths.dot}"/></svg>`;
const safeUrl=(value,fallback)=>{try{const url=new URL(value);return url.protocol==='https:'?url.href:fallback;}catch{return fallback;}};
const labels={queued:'Queued',generating:'Drafting…',pending:'Awaiting approval',published:'Published',error:'Needs attention',uncertain:'Check Facebook',removed:'Removed',rejected:'Reply dismissed',skipped:'No reply needed',publishing:'Publishing…',simulated:'Test approved'};
const isPublishedFilter=()=>['published','approved','automatic'].includes(filter);
const publicationLabel=c=>c.publish_kind==='external'?'Replied on Facebook':c.publish_kind==='automatic'?'Automatically published':['approved','edited'].includes(c.publish_kind)?'Approved by you':'Publication method unavailable';
const needsAttention=c=>!['removed','skipped'].includes(c.status)&&(['error','uncertain'].includes(c.status)||['error','uncertain'].includes(c.reaction_status));
const isNewComment=c=>['queued','generating','pending','publishing','error','uncertain'].includes(c.status);
const tabLabels={all:'All comments',new:'New comments',pending:'Awaiting approval',published:'All published',approved:'Approved by you',automatic:'Automatically published',rejected:'Dismissed replies',skipped:'No reply needed'};
const matchesTab=(c,key)=>c.status!=='removed'&&!c.cleared_at&&(key==='all'?!['published','rejected','skipped'].includes(c.status):key==='new'?isNewComment(c):key==='approved'?c.status==='published'&&['approved','edited'].includes(c.publish_kind):key==='automatic'?c.status==='published'&&c.publish_kind==='automatic':c.status===key);
const date=(at,seconds=false)=>new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{})});
const ago=at=>{const s=Math.max(0,Math.round((Date.now()-at)/1000));return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':s<86400?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago';};
// Status tone shared by list dots and the status pill: waiting on you, posted, needs attention, or quiet.
const tone=status=>['published','simulated'].includes(status)?'sent':['pending','queued','generating','publishing'].includes(status)?'wait':['error','uncertain'].includes(status)?'warn':'quiet';
const seenStatus=new Map(), renderedRows=new Set(), generationTabs=new Map();
// Last markup written to the list and the conversation pane: unchanged markup is not rewritten,
// so the 5-second refresh never resets scroll, hover or the opening animation.
let lastRowsHtml='', lastDetailHtml='';
const typing=el=>!!el&&(el.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(el.tagName));


function applyVisitorAccess(){
  const guest=!!state?.readOnly;
  $('#earnings-card').hidden=guest||!state;
  if(guest){clearEarnings();if($('#earnings-dialog').open)$('#earnings-dialog').close();earningsNextAt=0;earningsPage='';}
  $('#visitor-access').hidden=!guest;
  if(!guest)return;
  document.querySelectorAll('button,input,select,textarea').forEach(el=>{
    if(!el.matches('[data-row],[data-back]'))el.disabled=true;
  });
  document.querySelectorAll('a:not(#visitor-sign-in):not(.skip)').forEach(el=>{
    el.setAttribute('aria-disabled','true');el.tabIndex=-1;
  });
  $('#connection-banner').hidden=true;
  $('#live-banner-on').hidden=true;
  $('#agent-last').textContent='View only';
  $('#test-form').hidden=true;$('#palette').hidden=true;
  cloudflareUsage=state.cloudflare;renderCloudflare();
}
document.addEventListener('click',event=>{
  if(state&&!state.readOnly)return;
  const target=event.target.closest('button,a,input,select,textarea');
  if(target&&(target.id==='visitor-sign-in'||target.matches('[data-row],[data-back],.skip')))return;
  event.preventDefault();event.stopImmediatePropagation();
},true);
document.addEventListener('submit',event=>{
  if(state&&!state.readOnly)return;
  event.preventDefault();event.stopImmediatePropagation();
},true);

let noticeTimer;
function notice(message,error=false){const n=$('#notice');n.textContent=message;n.dataset.tone=error?'fault':'ok';n.hidden=false;clearTimeout(noticeTimer);if(!error)noticeTimer=setTimeout(()=>{n.hidden=true;},6000);}
async function api(path,input={}) {
  if(!state||state.readOnly)throw new Error('Sign in to make changes.');
  const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(input)});
  if(response.status===401){location.replace('/login');throw new Error('Please sign in.');}
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
async function action(button,fn,message) {
  if(!state||state.readOnly)return;
  // Buttons that hold live data (the agent switch: its label and last-activity time) keep their content; others show Working….
  const keep=!!button.querySelector('[id]'), original=button.innerHTML;
  button.disabled=true;if(keep)button.setAttribute('aria-busy','true');else button.textContent='Working…';
  try {await fn();if(message)notice(message);await refresh();} catch(error){notice(error.message,true);} finally{button.disabled=button.id==='memory-clear'&&!state.memory?.total;button.removeAttribute('aria-busy');if(button.id==='memory-toggle')button.textContent=(state.memory?.enabled??true)?'Turn learning off':'Turn learning on';else if(!keep)button.innerHTML=original;if(button.id==='clear-comment-history')renderComments();}
}
function nav(){const section=!state?.readOnly&&['queue','personality','connections','activity'].includes(location.hash.slice(1))?location.hash.slice(1):'queue';document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==section);document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});if(section==='personality'&&state)renderMemory();$('#section-label').textContent={queue:'Comment inbox',personality:'AI personality',connections:'Connections',activity:'Activity'}[section];}

// ---------- Inbox: list | thread | reply ----------
function visibleRows(){
  const rows=state.comments.filter(c=>(matchesTab(c,filter)||(c.status==='generating'&&generationTabs.get(c.id)===filter&&!c.cleared_at))&&(!search||[c.author,c.message,c.context,c.draft].some(value=>String(value||'').toLowerCase().includes(search))));
  if(isPublishedFilter())rows.sort((a,b)=>(b.published_at||b.created_at)-(a.published_at||a.created_at));
  return rows;
}
function renderFilters(){
  document.querySelectorAll('[data-filter]').forEach(button=>{
    const key=button.dataset.filter,count=state.tabCounts?.[key]??state.comments.filter(c=>matchesTab(c,key)).length;
    button.setAttribute('aria-pressed',String(key===filter));
    if(!button.classList.contains('kpi'))button.innerHTML=`${esc(tabLabels[key])} <span class="n"><span class="p">(</span>${count.toLocaleString()}<span class="p">)</span></span>`;
  });
}
function renderComments() {
  // A selected conversation stays in its current tab while AI works on it.
  // Its real status still controls counts and approval; terminal statuses are never pinned.
  for(const c of state.comments){
    if(c.status!=='generating'){generationTabs.delete(c.id);continue;}
    const previous=seenStatus.get(c.id);
    if(!generationTabs.has(c.id)&&c.id===selected&&previous&&matchesTab({...c,status:previous},filter))generationTabs.set(c.id,filter);
  }
  for(const id of generationTabs.keys())if(!state.comments.some(c=>c.id===id))generationTabs.delete(id);
  renderFilters();
  const rows=visibleRows();
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
  if(!rows.some(c=>c.id===selected))selected=rows[0]?.id??null;

  const fresh=rows.filter(c=>!renderedRows.has(c.id)).map(c=>c.id);
  const rowsHtml=rows.map(c=>{
    const preview=c.draft&&['published','simulated'].includes(c.status)?'You: '+c.draft:c.message;
    return `<button type="button" class="row" role="option" data-row="${esc(c.id)}" aria-selected="${c.id===selected}"><span class="row-dot" data-tone="${needsAttention(c)?'warn':tone(c.status)}" aria-hidden="true"></span><span class="row-who">${esc(c.author||'Facebook user')}</span><time class="row-time" datetime="${new Date(c.created_at).toISOString()}">${ago(c.created_at)}</time><span class="row-text">${esc(preview)}</span><span class="row-state">${c.is_followup?'Follow-up, ':c.source==='test'?'Test, ':''}${c.status==='published'&&needsAttention(c)?'Like needs checking':esc(labels[c.status]||c.status)}</span></button>`;
  }).join('');
  if(rowsHtml!==lastRowsHtml){$('#comment-rows').innerHTML=rowsHtml;lastRowsHtml=rowsHtml;}
  // Newly arrived rows slide in once, staggered; existing rows never re-animate.
  fresh.forEach((id,i)=>{const r=[...document.querySelectorAll('#comment-rows [data-row]')].find(r=>r.dataset.row===id);if(r){r.style.setProperty('--i',i);r.classList.add('enter');r.addEventListener('animationend',()=>r.classList.remove('enter'),{once:true});}renderedRows.add(id);});

  const detailHtml=rows.length?rows.map(c=>{
    const fbUrl='https://www.facebook.com/'+encodeURIComponent(c.post_id||'');
    const postUrl=safeUrl(c.post_url,fbUrl);
    const imageUrl=safeUrl(c.post_image,'');
    const statusIcon=needsAttention(c)?'alert':['published','simulated'].includes(c.status)?'check':['pending','queued','generating'].includes(c.status)?'wait':'msg';
    if(draftEdits.has(c.id)&&(draftEdits.get(c.id).base!==c.draft||!['pending','generating'].includes(c.status)))draftEdits.delete(c.id);
    const grammarOnly=ideaModes.get(c.id)==='grammar';
    const editable=c.status==='pending';
    const posted=['published','simulated'].includes(c.status);
    const landed=posted&&seenStatus.has(c.id)&&!['published','simulated'].includes(seenStatus.get(c.id));
    const replyTitle=c.status==='generating'?'Generating a new reply':posted?(c.source==='test'?'Approved test reply':'Published reply'):editable?'AI reply draft':'Unpublished AI reply';
    const postCaption=c.context||(c.source==='test'?'No post context supplied.':c.post_loaded?'This post has no caption.':'Post caption is not available yet.');
    const commentLink=new URL(postUrl);commentLink.searchParams.set('comment_id',String(c.id).split('_').pop());
    const liked=c.reaction_applied==='LIKE'&&['applied','manual','simulated'].includes(c.reaction_status);
    const likeLabel=liked?(c.source==='test'?'Test Like simulated':'Liked'):c.reaction_status==='applying'?'Applying Like?':c.reaction_error?'Like needs checking':c.like_after_publish?'Like queued':posted?'No Like recorded':['skipped','rejected'].includes(c.status)?'No reply published':'Included with publishing';
    const like=`<div class="like"><div class="like-h"><strong>Like on this comment</strong><span>${likeLabel}</span></div><p class="like-text">${liked?(c.source==='test'?'Reply and Like were simulated. Nothing was posted to Facebook.':'Like applied with the published reply.'):c.reaction_error?'Your reply remains published. Check the Like on Facebook; the reply will not be sent again.':posted?(c.like_after_publish?'The reply was published; its Like is being applied.':'This older reply has no recorded automatic Like.'):['skipped','rejected'].includes(c.status)?'A Like is applied only if you publish a reply.':'Publishing this reply also applies a Like. No separate approval is needed.'}</p>${c.reaction_error?`<p class="fault">${esc(c.reaction_error)}</p>`:''}${c.reaction_error&&c.source==='facebook'?`<a class="ext" href="${esc(commentLink.href)}" target="_blank" rel="noopener noreferrer">Check comment on Facebook ${icon('ext')}</a>`:''}</div>`;
    let threadHistory=[];try{threadHistory=JSON.parse(c.thread_history||'[]');if(!Array.isArray(threadHistory))threadHistory=[];}catch{}
    const thread=threadHistory.length?`<section class="thread-history" aria-label="Conversation history"><h3 class="sec-h">Conversation history</h3>${threadHistory.slice(-40).map(m=>`<div class="thread-message${m.isPage?' from-page':''}"><div class="thread-author"><strong>${esc(m.isPage?'Your Page':m.author||'Facebook user')}</strong>${m.at?`<time datetime="${new Date(m.at).toISOString()}">${date(m.at)}</time>`:''}</div><p>${esc(m.message)}</p></div>`).join('')}</section>`:'';
    const personalityButton=`<button type="button" class="btn" data-action="draft-personality" title="Generate a fresh reply using your Wine and Silence personality">${icon('spark')}Wine &amp; Silence</button>`;
    const controls=`${editable?`<button type="button" class="btn btn-accent" data-action="approve">${icon('send')}${c.source==='test'?'Approve test reply':'Approve & publish reply'}<kbd>A</kbd></button>`:''}${['queued','pending','error'].includes(c.status)?`<button type="button" class="btn" data-action="draft">${icon('again')}${c.draft?'Regenerate reply':'Generate reply'}<kbd>R</kbd></button>${personalityButton}<button type="button" class="btn btn-ghost btn-danger" data-action="reject">Dismiss reply</button>`:''}${['rejected','skipped'].includes(c.status)?`<button type="button" class="btn" data-action="draft">${icon('again')}Generate new reply<kbd>R</kbd></button>${personalityButton}`:''}${c.status==='uncertain'?'<button type="button" class="btn" data-action="resolve-published">I checked: reply was posted</button><button type="button" class="btn" data-action="resolve-pending">I checked: no reply was posted</button>':''}`;
    return `<article class="convo" data-comment="${esc(c.id)}" aria-label="Conversation with ${esc(c.author||'Facebook user')}" ${c.id===selected?'':'hidden'}>
      <div class="convo-thread">
        <header class="convo-head"><button type="button" class="btn btn-ghost back" data-back>${icon('back')}Back</button><span class="convo-from">${icon(c.source==='test'?'flask':'msg')}${c.source==='test'?'Test conversation':'Facebook conversation'}</span><time datetime="${new Date(c.created_at).toISOString()}">Received: ${date(c.created_at,true)}</time><span class="state${landed?' landed':''}" data-tone="${needsAttention(c)?'warn':tone(c.status)}">${icon(statusIcon)}${c.status==='published'&&needsAttention(c)?'Like needs checking':c.status==='published'?(c.publish_kind==='automatic'?'Automatically published':'Published'):labels[c.status]||esc(c.status)}</span></header>
        <section class="post${imageUrl&&c.source==='facebook'?'':' post-noimg'}" aria-label="Post context">
          ${imageUrl&&c.source==='facebook'?`<a href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer"><img class="post-img" src="${esc(imageUrl)}" alt="Facebook post preview" loading="lazy" width="96" height="96"></a>`:''}
          <div class="post-body"><h3 class="sec-h">${c.source==='test'?'Test post context':'Your Facebook post / Reel'}</h3><div class="post-text">${esc(postCaption)}</div>${c.source==='facebook'?`<a class="ext" href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer">Open post on Facebook ${icon('ext')}</a>`:'<span class="test-tag">Local test. Nothing posts to Facebook.</span>'}</div>
        </section>
        ${thread}
        <section class="said" aria-label="Customer comment"><h3 class="sec-h">${c.is_followup?'Latest follow-up':'Customer comment'}</h3><div class="who"><span class="avatar" aria-hidden="true">${esc((c.author||'F').slice(0,1).toUpperCase())}</span><strong>${esc(c.author||'Facebook user')}</strong><span>commented</span></div><blockquote class="said-text">${esc(c.message)}</blockquote></section>
        ${like}
      </div>
      <section class="convo-reply${posted?' is-posted':''}" aria-label="${replyTitle}">
        <div class="reply-h"><h3>${c.draft?replyTitle:'Your reply'}</h3><span class="reply-flag">${c.status==='generating'?'Generating&hellip;':posted?'Sent':editable?'Not published':'Not sent'}</span></div>
        ${c.source==='facebook'&&['queued','generating','pending'].includes(c.status)&&c.created_at+(state.settings.commentDelaySeconds||0)*1000>Date.now()?`<p class="note"><strong>Minimum comment delay:</strong> This reply can publish after ${date(c.created_at+state.settings.commentDelaySeconds*1000,true)}. Drafting and editing can happen now.</p>`:''}
        ${c.status==='published'?`<p class="reply-meta">${publicationLabel(c)}.${c.published_at?' Published at '+date(c.published_at,true)+'.':''}${c.publish_kind==='edited'?' You edited this reply before approving.':''}</p>`:''}
        ${c.status==='skipped'?`<p class="note"><strong>No reply needed:</strong> ${esc(c.reason||'This comment has no clear message to respond to.')} No reply will be published. You can reassess it manually; any restored draft will wait for your approval.</p>`:''}
        ${c.is_followup&&!posted?'<p class="note"><strong>Follow-up:</strong> Always waits for your approval, including in Automatic mode.</p>':''}
        ${c.status==='pending'&&c.reply_decision==='REVIEW'?'<p class="note"><strong>Meaning needs review:</strong> This reply needs your approval, including in Automatic mode.</p>':''}
        ${c.status==='rejected'?'<p class="guide">This reply was dismissed. You can generate a new reply whenever you want; it will wait for your approval.</p>':''}
        ${c.draft||editable?`<div class="draft">${c.status==='generating'?'<p class="guide">AI is working on your reply. The previous draft is shown until it is ready.</p>':''}${editable?'<p class="guide">Edit the reply, then approve it to publish.</p>':''}<textarea aria-label="Reply to ${esc(c.author)}" data-draft="${esc(c.id)}" data-original="${esc(c.draft)}" rows="6" maxlength="1000" ${editable?'':'readonly'}>${esc(editable||c.status==='generating'?(draftEdits.get(c.id)?.text??c.draft):c.draft)}</textarea>${c.reason?`<p class="note"><strong>Review note:</strong> ${esc(c.reason)}</p>`:''}</div>`:`<p class="empty-reply">${c.status==='generating'?'AI is writing a reply. It will appear here shortly.':c.status==='queued'?(state.replyAI?.enabled?'Waiting for automatic drafting. Replies are generated one at a time.':'Connect your selected Reply AI provider to generate this reply automatically.'):'No reply has been generated for this comment.'}</p>`}
        ${c.error?`<p class="fault"><strong>Needs attention:</strong> ${esc(c.error)}</p>`:''}
        ${controls?`<div class="actions">${controls}</div>`:''}
        ${['queued','pending','error','rejected','skipped','generating'].includes(c.status)?`<div class="coach"><label class="coach-title" for="idea-${esc(c.id)}">Work on this reply with AI</label><p>${grammarOnly?'Paste your reply below. AI will only correct spelling, grammar, and punctuation, preserving your meaning and tone.':'Share your idea or tell the AI what to change. It will use this comment, the post, and your current draft.'}</p><label class="coach-pick">What should AI do?<select data-idea-mode="${esc(c.id)}" aria-label="AI editing mode for ${esc(c.author)}" ${c.status==='generating'?'disabled':''}><option value="improve" ${!grammarOnly?'selected':''}>Improve my idea</option><option value="grammar" ${grammarOnly?'selected':''}>Correct grammar only</option></select></label><textarea id="idea-${esc(c.id)}" data-idea="${esc(c.id)}" aria-label="Your idea for replying to ${esc(c.author)}" rows="2" maxlength="${grammarOnly?1000:2000}" placeholder="${grammarOnly?'Type the exact reply you want corrected.':'For example: Say I appreciate their support, but make it sound more personal.'}" ${c.status==='generating'?'disabled':''}>${esc(ideaEdits.get(c.id)||'')}</textarea><div class="coach-f"><span>Creates a draft for your approval.</span><button type="button" class="btn" data-action="refine" ${c.status==='generating'?'disabled':''}>${icon('spark')}${grammarOnly?'Correct grammar':'Write reply from my idea'}</button></div></div>`:''}
      </section></article>`;
  }).join(''):`<div class="listening"><div class="radar${state.live?.on?'':' idle'}" aria-hidden="true"></div><h2>${search?'No matching conversations.':filter==='all'?(state.live?.on?'Agent listening…':'Agent is off.'):'All caught up.'}</h2><p>${search?'Try another name, comment, or phrase.':filter==='all'?(state.live?.on?'New comments appear here the moment Facebook sends them. Try a test comment to hear your AI voice.':'Turn Live On to receive new comments, or try a test comment.'):'New conversations matching this filter will appear here.'}</p></div>`;
  if(detailHtml!==lastDetailHtml){
    const open=currentDetail(), scrolls=open?{id:open.dataset.comment,thread:open.querySelector('.convo-thread')?.scrollTop||0,reply:open.querySelector('.convo-reply')?.scrollTop||0}:null;
    target.innerHTML=detailHtml;lastDetailHtml=detailHtml;
    const now=currentDetail();
    if(now&&scrolls?.id===now.dataset.comment){now.querySelector('.convo-thread').scrollTop=scrolls.thread;now.querySelector('.convo-reply').scrollTop=scrolls.reply;}
    if(ideaFocus){const t=[...target.querySelectorAll('textarea[data-idea]')].find(t=>t.dataset.idea===ideaFocus);if(t&&!t.disabled){t.focus({preventScroll:true});t.setSelectionRange(start,end);}}
    if(focus){const t=[...target.querySelectorAll('textarea')].find(t=>t.dataset.draft===focus);if(t){t.focus({preventScroll:true});t.setSelectionRange(start,end);}}
  }
  if(!rows.length)$('#workspace').dataset.pane='list';
  for(const c of state.comments)seenStatus.set(c.id,c.status);
}
// Show one conversation without re-rendering, so unsent edits and focus stay put.
function selectComment(id,{open=false,scroll=true}={}){
  if(!id)return;selected=id;
  document.querySelectorAll('#comment-rows [data-row]').forEach(r=>r.setAttribute('aria-selected',String(r.dataset.row===id)));
  document.querySelectorAll('#comments [data-comment]').forEach(d=>{const show=d.dataset.comment===id;if(show&&d.hidden){d.classList.remove('opening');void d.offsetWidth;d.classList.add('opening');}d.hidden=!show;});
  if(scroll)[...document.querySelectorAll('#comment-rows [data-row]')].find(r=>r.dataset.row===id)?.scrollIntoView({block:'nearest'});
  if(open)$('#workspace').dataset.pane='detail';
}
const currentDetail=()=>[...document.querySelectorAll('#comments [data-comment]')].find(d=>!d.hidden);
function moveSelection(step){
  const ids=[...document.querySelectorAll('#comment-rows [data-row]')].map(r=>r.dataset.row);if(!ids.length)return;
  const i=Math.max(0,ids.indexOf(selected));selectComment(ids[Math.min(ids.length-1,Math.max(0,i+step))]);
}

// ---------- KPIs: current status counts and 24h event totals ----------
function sparkline(svg,times){
  const now=Date.now(),hour=3600e3,buckets=Array(12).fill(0);
  for(const t of times){const h=Math.floor((now-t)/hour);if(h>=0&&h<12)buckets[11-h]++;}
  const max=Math.max(1,...buckets);
  svg.innerHTML=buckets.map((n,i)=>`<rect x="${i*8}" y="${24-Math.max(2,Math.round(n/max*22))}" width="6" height="${Math.max(2,Math.round(n/max*22))}" rx="1"${i===11?' class="now"':''}/>`).join('');
}
function renderKpis(){
  const day=Date.now()-86400e3, sets=state.kpiTimes||{new:[],pending:[],published:[],automatic:[]};
  for(const key of ['new','pending','published','automatic']){
    const times=sets[key]||[],id=key==='automatic'?'auto':key;
    sparkline($('#spark-'+id),times);
    const recent=times.filter(t=>t>=day).length;
    $('#delta-'+id).textContent=(recent?'+'+recent:'0')+' in 24h';
  }
}

// ---------- Page header: followers, trend, sync ----------
const SYNC_MS=5*60*1000;
let shownFollowers=null,countFrame=0;
const calm=()=>!window.requestAnimationFrame||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// Rolls the follower number to its new value; flashes lime when it goes up.
function countTo(value){
  const el=$('#head-followers');window.cancelAnimationFrame?.(countFrame);
  if(value===null){shownFollowers=null;el.textContent='–';return;}
  const from=shownFollowers;shownFollowers=value;
  if(from===value){el.textContent=value.toLocaleString();return;}
  el.classList.remove('up','down');
  if(from!==null)el.classList.add(value>from?'up':'down');
  if(calm()){el.textContent=value.toLocaleString();setTimeout(()=>el.classList.remove('up','down'),1600);return;}
  const start=from??Math.max(0,Math.round(value*.9)),t0=performance.now(),dur=from===null?900:700;
  const step=now=>{const k=Math.min(1,(now-t0)/dur),e=1-Math.pow(1-k,3);el.textContent=Math.round(start+(value-start)*e).toLocaleString();if(k<1)countFrame=requestAnimationFrame(step);else setTimeout(()=>el.classList.remove('up','down'),1400);};
  countFrame=requestAnimationFrame(step);
}
// Import the owner's legacy browser readings once; visitors never write history.
const followerImportAttempts=new Map();
async function migrateFollowerHistory(){
  const fb=state.facebook,pageId=state.settings.pageId;
  if(state.readOnly||!fb.configured||fb.followersHistoryReady||!Number.isSafeInteger(fb.followersCount)||!fb.followersUpdatedAt||Date.now()<(followerImportAttempts.get(pageId)||0))return;
  followerImportAttempts.set(pageId,Date.now()+300000);
  let readings=[];try{readings=JSON.parse(localStorage.getItem('socialite:followers:'+pageId)||'[]');}catch{return;}
  if(!Array.isArray(readings)||!readings.length)return;
  const now=Date.now();
  readings=readings.filter(p=>Array.isArray(p)&&p.length===2&&Number.isSafeInteger(p[0])&&Number.isSafeInteger(p[1])&&p[1]>=0&&p[0]>=now-7*86400e3&&p[0]<=now&&p[0]!==fb.followersUpdatedAt).sort((a,b)=>a[0]-b[0]).slice(-399);
  if(!readings.length)return;
  readings.push([fb.followersUpdatedAt,fb.followersCount]);
  try{Object.assign(fb,await api('facebook/follower-history',{pageId,readings}));followerImportAttempts.set(pageId,Infinity);}
  catch(error){followerImportAttempts.set(pageId,Date.now()+60000);notice('Could not transfer older follower readings: '+error.message,true);}
}
let trendHours=[],trendActive=-1;
const trendTime=t=>new Date(t).toLocaleTimeString('en-SG',{timeZone:'Asia/Singapore',hour:'numeric',hour12:true}).replace(/\s/g,'').toUpperCase();
const trendRange=t=>{const a=trendTime(t-3600e3),b=trendTime(t);return a.replace(/(AM|PM)$/,suffix=>b.endsWith(suffix)?'':suffix)+'\u2013'+b;};
function hideTrendDetails(){
  $('#head-trend-tooltip').hidden=true;trendActive=-1;
  $('#head-trend').querySelectorAll('.active').forEach(el=>el.classList.remove('active'));
}
function showTrendDetails(index){
  const p=trendHours[index];if(!p||!Number.isFinite(p.value)){hideTrendDetails();return;}
  trendActive=index;
  const tooltip=$('#head-trend-tooltip'),svg=$('#head-trend');
  svg.querySelectorAll('.active').forEach(el=>el.classList.remove('active'));
  svg.querySelector(`[data-hour-dot="${index}"]`)?.classList.add('active');
  const date=new Date(p.t-3600e3).toLocaleDateString('en-SG',{timeZone:'Asia/Singapore',day:'numeric',month:'short'});
  tooltip.innerHTML=esc(date+' · '+trendRange(p.t)+' SGT')+'<strong>'+esc((p.value>0?'+':'')+p.value.toLocaleString()+' net followers')+'</strong>';
  tooltip.hidden=false;
  const box=svg.getBoundingClientRect();
  tooltip.style.left=Math.max(12,Math.min(window.innerWidth-244,box.left+index/23*box.width-110))+'px';
  tooltip.style.top=(box.top>80?box.top-72:box.bottom+8)+'px';
}
const trendSvg=$('#head-trend');
for(const name of ['pointermove','pointerdown'])trendSvg.addEventListener(name,event=>{
  const hit=event.target.closest('[data-trend-hour]');if(hit)showTrendDetails(Number(hit.dataset.trendHour));else hideTrendDetails();
});
trendSvg.addEventListener('pointerleave',event=>{if(event.pointerType!=='touch')hideTrendDetails();});
trendSvg.addEventListener('focus',()=>{const index=trendHours.findLastIndex(p=>Number.isFinite(p.value));if(index>=0)showTrendDetails(index);});
trendSvg.addEventListener('blur',hideTrendDetails);
trendSvg.addEventListener('keydown',event=>{
  if(event.key==='Escape'){hideTrendDetails();event.stopPropagation();return;}
  if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();const direction=event.key==='ArrowLeft'?-1:1;
  for(let i=trendActive+direction;i>=0&&i<trendHours.length;i+=direction)if(Number.isFinite(trendHours[i].value)){showTrendDetails(i);break;}
});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.pb-trend-wrap'))hideTrendDetails();});
window.addEventListener('scroll',hideTrendDetails,true);
window.addEventListener('resize',hideTrendDetails);
// Completed hourly gains from recorded counts; gaps and unfinished hours stay out.
function drawTrend(points){
  hideTrendDetails();
  const svg=$('#head-trend'),hour=3600e3,now=Date.now(),end=Math.floor(now/hour)*hour,start=end-24*hour;
  const readings=points.filter(p=>Array.isArray(p)&&Number.isSafeInteger(p[0])&&Number.isSafeInteger(p[1])&&p[1]>=0&&p[0]<=now).sort((a,b)=>a[0]-b[0]);
  const at=time=>{const p=readings.findLast(p=>p[0]<=time);return p&&time-p[0]<=15*60000?p[1]:null;};
  const gains=Array.from({length:24},(_,i)=>{const t=start+(i+1)*hour,a=at(t-hour),b=at(t);return {t,value:a!==null&&b!==null?b-a:null};});
  const valid=gains.filter(p=>Number.isFinite(p.value)),vals=valid.map(p=>p.value),lo=Math.min(0,...vals),hi=Math.max(0,...vals);
  trendHours=gains;
  const summary=$('#head-trend-summary');summary.hidden=!valid.length;
  const low=valid.find(p=>p.value===Math.min(...vals));
  const actualPeak=valid.find(p=>p.value===Math.max(...vals));
  summary.innerHTML=valid.length<2?'1 recorded hour':Math.max(...vals)===Math.min(...vals)?'Steady '+esc((vals[0]>0?'+':'')+vals[0])+' / hour':`<span>Peak <b>${esc(trendRange(actualPeak.t))}</b></span><span>Low <b>${esc(trendRange(low.t))}</b></span>`;
  summary.title=valid.length?'Singapore time. Highest and lowest net gains among recorded hours; earliest hour shown when tied.':'';
  const y=value=>hi===lo?22:36-(value-lo)/(hi-lo)*30;
  const label='Net follower gains per completed hour, last 24 hours. Missing readings are left blank; the unfinished hour is excluded.';
  svg.setAttribute('aria-label',label+(valid.length?' Latest recorded hour: '+valid.at(-1).value+'.':' Waiting for hourly history.'));
  $('#head-trend-label').textContent=valid.length?'Hourly gains / 24 hours':'Collecting hourly gains';
  $('#head-trend-label').title=label;
  let line='',previous=-2,previousX=0,previousY=0;
  const dots=[],hits=[];
  gains.forEach((p,i)=>{
    if(!Number.isFinite(p.value))return;
    const x=3+i/Math.max(1,gains.length-1)*154,cy=y(p.value);
    const coordinate=x.toFixed(1)+' '+cy.toFixed(1);
    // Horizontal endpoint tangents keep each smooth segment within its actual values.
    const connect=' C'+(previousX+(x-previousX)/3).toFixed(1)+' '+previousY.toFixed(1)+' '+(x-(x-previousX)/3).toFixed(1)+' '+cy.toFixed(1)+' '+coordinate;
    line+=previous===i-1?connect:' M'+coordinate;
    previous=i;previousX=x;previousY=cy;
    const time=t=>new Date(t).toLocaleString('en-SG',{timeZone:'Asia/Singapore',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false});
    const title=time(p.t-hour)+' to '+time(p.t)+' SGT: '+(p.value>0?'+':'')+p.value+' net followers in 1 hour';
    dots.push(`<circle data-hour-dot="${i}" class="${p.value<0?'loss ':''}${p===valid.at(-1)?'latest ':''}tip" cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${p===valid.at(-1)?2.5:3}"><title>${esc(title)}</title></circle>`);
    hits.push(`<rect class="hour-hit" data-trend-hour="${i}" x="${Math.max(0,x-3.35).toFixed(1)}" y="0" width="6.7" height="40"/>`);

  });
  const area=path=>path.trim().split(/\s*M/).filter(Boolean).map(part=>{const numbers=part.match(/-?\d+(?:\.\d+)?/g);return `<path class="area" d="M${part} L${numbers.at(-2)} 40 L${numbers[0]} 40 Z"/>`;}).join('');
  svg.innerHTML=valid.length?'<defs><linearGradient id="pb-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c6ff3d" stop-opacity=".16"/><stop offset="1" stop-color="#c6ff3d" stop-opacity="0"/></linearGradient></defs>'+(lo<0||hi===lo?`<line class="flat" x1="0" y1="${y(0).toFixed(1)}" x2="160" y2="${y(0).toFixed(1)}"/>`:'')+(hi!==lo?area(line)+(line?`<path class="line" d="${line.trim()}"/>`:''):'')+dots.join('')+hits.join(''):'';
}
function renderPagebar(){
  const fb=state.facebook,s=state.settings,ok=!!fb.configured,n=fb.followersCount,has=ok&&Number.isSafeInteger(n)&&n>=0,at=fb.followersUpdatedAt,live=!!state.live?.on;
  const name=ok?(fb.pageName||'Page '+s.pageId):'Facebook Page not connected';
  $('.pagebar').dataset.live=String(ok&&live);
  $('#head-page').textContent=name;
  $('#head-logo').hidden=!ok;$('#head-initial').hidden=ok;
  $('#head-monetization').hidden=!ok;
  $('#head-initial').textContent=ok?name.trim().slice(0,1).toUpperCase():'?';
  $('#head-dot').dataset.on=String(ok);
  $('#head-sync').textContent=!ok?'Not connected':live?'Live on Facebook':'Paused while Live Off';
  $('#head-followers-label').textContent=n===1?'follower':'followers';
  $('#head-updated').textContent=has&&at?'Updated '+new Date(at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'';
  const created=fb.pageCreatedAt,age=$('#head-age'),hasAge=ok&&Number.isFinite(created)&&created>0&&created<=Date.now();
  age.hidden=!hasAge;
  if(hasAge){
    const days=Math.floor((Date.now()-created)/86400e3);
    age.innerHTML='<span>Facebook Page &middot; <b>'+days.toLocaleString()+'</b> '+(days===1?'day':'days')+' old</span>';
    age.title='Created '+new Date(created).toLocaleString('en-SG',{timeZone:'Asia/Singapore',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' SGT. Date supplied by the Page owner.';
    age.setAttribute('aria-label','Facebook Page age: '+days+' '+(days===1?'day':'days')+'. '+age.title);
  }else{age.textContent='';age.title='';age.removeAttribute('aria-label');}
  countTo(has?n:null);
  drawTrend(has&&Array.isArray(fb.followersHistory)?fb.followersHistory:[]);
  const delta=$('#head-delta'),d=has&&Number.isFinite(fb.followersDelta24h)?fb.followersDelta24h:null;
  delta.classList.remove('up','down');
  delta.textContent=d===null?'':d?(d>0?'+':'')+d.toLocaleString()+' in 24h':'';
  delta.title=d!==null?'Change based on the shared 24-hour Facebook follower history.':'';
  if(d)delta.classList.add(d>0?'up':'down');
  $('#head-next').style.setProperty('--p',has&&at&&live?Math.min(1,Math.max(0,(Date.now()-at)/SYNC_MS)).toFixed(3):'0');
}
function render(){
  if(state.readOnly){filter='automatic';nav();}
  document.body.dataset.access=state.readOnly?'visitor':'owner';
  $('#header-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
  const replyAI=state.replyAI||{provider:'huggingface',enabled:false};
  const chatgpt=!!state.chatgpt?.enabled;
  const hf=!!(state.settings.hfSpace&&state.huggingface?.hasToken);
  const providerNames={chatgpt:'ChatGPT',huggingface:'Hugging Face',fallback:'ChatGPT + Hugging Face'};
  $('#rail-ai-name').textContent=providerNames[replyAI.provider]||'Reply AI';
  $('#rail-ai-status').textContent=!replyAI.enabled?'Not connected':replyAI.provider==='fallback'?(chatgpt?'ChatGPT first'+(hf?' · HF backup':''):'Hugging Face available'):replyAI.provider==='chatgpt'?'ChatGPT connected':'ZeroGPU Space';
  $('#rail-ai-dot').dataset.on=String(!!replyAI.enabled);
  $('#provider-status').textContent=providerNames[replyAI.provider]||'Reply AI';
  $('#ai-status').textContent=chatgpt?'Plan connected':'Not connected';
  $('#ai-description').textContent=chatgpt?'Connected as '+(state.chatgpt.email||'your ChatGPT account')+'. Reply generation uses your ChatGPT plan.':'No copied ChatGPT session is connected. Transfer one from local Socialite to use ChatGPT online.';
  $('#load-models').disabled=!chatgpt;
  $('#save-model').disabled=!chatgpt||!$('#model-select').value;
  $('#disconnect-chatgpt').disabled=!chatgpt;
  $('#model-saved').textContent='Saved model: '+(state.settings.model||'automatic');
  const providerReady=replyAI.provider==='chatgpt'?chatgpt:replyAI.provider==='huggingface'?hf:chatgpt||hf;
  $('#local-saved').textContent=providerReady?replyAI.provider==='fallback'?(chatgpt&&hf?'ChatGPT and Hugging Face are ready':chatgpt?'ChatGPT is ready; add Hugging Face for backup.':'Hugging Face is ready; add ChatGPT for first choice.'):replyAI.provider==='chatgpt'?'ChatGPT plan connected as '+(state.chatgpt.email||'your account'):'Connected to Space '+state.settings.hfSpace:replyAI.provider==='chatgpt'?'Connect a ChatGPT session from local Socialite.':replyAI.provider==='huggingface'?'Add your Space and access token.':'Connect ChatGPT or Hugging Face to write replies.';
  $('#local-saved').className='status '+(providerReady?'ok':'bad');
  const pageLabel=state.facebook.configured?(state.facebook.pageName||'Page '+state.settings.pageId):'Not configured';
  $('#rail-fb-status').textContent=pageLabel;
  $('#rail-fb-status').title=state.facebook.configured?'Facebook Page ID: '+state.settings.pageId:'';
  $('#rail-fb-dot').dataset.on=String(!!state.facebook.configured);
  const followers=state.facebook.followersCount, hasFollowers=state.facebook.configured&&Number.isSafeInteger(followers)&&followers>=0;
  $('#rail-fb-followers').hidden=!state.facebook.configured;
  $('#rail-fb-followers').textContent=hasFollowers?followers.toLocaleString()+' '+(followers===1?'follower':'followers'):'Followers unavailable';
  const updated=state.facebook.followersUpdatedAt;
  $('#rail-fb-updated').hidden=!hasFollowers||!updated;
  $('#rail-fb-updated').textContent=updated?'Updated '+new Date(updated).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'';
  $('#rail-fb-updated').title=updated?'Last fetched: '+new Date(updated).toLocaleString()+'. Refreshes every 5 minutes. Verify Page in Connections to refresh now.':'';
  renderPagebar();
  const newCount=state.tabCounts?.new??state.comments.filter(isNewComment).length;
  $('#stat-new').textContent=newCount.toLocaleString();
  const openCount=state.comments.filter(isNewComment).length;
  $('#nav-count').textContent=openCount.toLocaleString();
  $('#nav-count').title=openCount+' open comments, including those waiting for an AI draft';
  $('#stat-pending').textContent=(state.tabCounts?.pending??state.comments.filter(c=>c.status==='pending').length).toLocaleString();
  $('#stat-published').textContent=(state.tabCounts?.published??state.comments.filter(c=>c.status==='published').length).toLocaleString();
  $('#stat-auto').textContent=(state.tabCounts?.automatic??state.comments.filter(c=>c.status==='published'&&c.publish_kind==='automatic').length).toLocaleString();
  $('#mode-label').textContent={approval:'Approval required',hybrid:'Hybrid publishing',automatic:'Automatic publishing'}[state.settings.mode];
  $('#connection-banner').hidden=replyAI.enabled&&state.facebook.configured;
  $('#fb-status').textContent=state.facebook.configured?(pageLabel+(state.facebook.hasAppSecret?'':' - App secret needed')):'Not configured';
  $('#webhook-address').value=state.webhookUrl;
  const live=state.live||{}, webhookHere=live.on&&live.receiving;
  $('#webhook-status').textContent=live.on?'Live On':'Live Off';
  $('#webhook-line').textContent=webhookHere?'New comments arrive here.':live.on?'Connecting. Comments will arrive here shortly.':live.target?'Live Off. Comments currently go to your other Socialite app.':'Live Off. Comments are not received.';
  $('#webhook-line').className='status '+(webhookHere?'ok':live.on?'busy':'');
  $('#connect-webhook').textContent=live.on?'Turn Live Off':'Turn Live On';
  $('#connect-webhook').className='btn '+(live.on?'':'btn-accent');
  $('#verify-token').value=state.facebook.verifyToken;
  $('#activity-list').innerHTML=state.activity.length?state.activity.map(a=>`<div class="log-row"><time datetime="${new Date(a.at).toISOString()}">${date(a.at,true)}</time><span>${esc(a.message)}</span></div>`).join(''):'<p>Activity will appear here.</p>';
  $('#agent-last').textContent=state.activity[0]?'Active '+ago(state.activity[0].at):'No activity yet';
  renderKpis();renderComments();renderMemory();renderLive();applyVisitorAccess();
}
function renderMemory(){
  if(state.readOnly)return;
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
    $('#memory-list').innerHTML=data.rows.length?data.rows.map(r=>`<details class="mem"><summary><span>${esc(r.reply)}</span><small>${esc(names[r.kind]||'Published reply')}, ${date(r.published_at)}</small></summary><div class="mem-body"><strong>Customer comment</strong><p>${esc(r.comment)}</p><strong>Post context</strong><p>${esc(r.post||'No caption recorded.')}</p><strong>Published reply</strong><p>${esc(r.reply)}</p><button type="button" class="btn btn-ghost btn-danger" data-memory-delete="${esc(r.comment_id)}">Forget this example</button></div></details>`).join(''):'<p class="hint">No saved examples yet. Test comments, dismissed drafts, and unconfirmed posting attempts are never used for learning.</p>';
    $('#memory-page').textContent=data.total?`${data.offset+1}-${Math.min(data.offset+20,data.total)} of ${data.total}`:'0 examples';
    $('#memory-prev').disabled=data.offset===0;$('#memory-next').disabled=data.offset+20>=data.total;
  }).catch(error=>{if(request!==memoryRequest)return;memorySignature='';$('#memory-list').textContent=error.message;});
}
$('#memory-toggle').onclick=()=>action($('#memory-toggle'),async()=>{await api('settings',{learningEnabled:!(state.memory?.enabled??true)});},'Reply learning preference saved.');
$('#memory-clear').onclick=()=>action($('#memory-clear'),async()=>{await api('memory/clear');memoryOffset=0;memorySignature='';},"This Page's reply memory was cleared. Published comments remain intact.");
$('#memory-list').addEventListener('click',event=>{const b=event.target.closest('[data-memory-delete]');if(b)action(b,async()=>{await api('memory/delete',{id:b.dataset.memoryDelete});memorySignature='';},'Example forgotten.');});
$('#memory-prev').onclick=()=>{memoryOffset=Math.max(0,memoryOffset-20);renderMemory();};
$('#memory-next').onclick=()=>{memoryOffset+=20;renderMemory();};
async function refresh(initial=false){if(loading)return;loading=true;try{let response=await fetch(visitorMode?'/api/public-state':'/api/state',{headers:stateETag?{'If-None-Match':stateETag}:{}}).catch(()=>{pollRetryAt=Date.now()+60000;throw new Error('Cannot reach Socialite. Check your internet connection.');});if(response.status===401){visitorMode=true;stateETag='';response=await fetch('/api/public-state');}if(response.status===304){pollRetryAt=0;return;}if(!response.ok){const retry=Number(response.headers?.get('Retry-After'));pollRetryAt=Date.now()+(retry>0?retry*1000:60000);const error=await response.json().catch(()=>({}));throw new Error(error.error||'Cannot load dashboard');}state=await response.json();visitorMode=!!state.readOnly;if(visitorMode){visitorNextAt=Date.now()+60000;filter='automatic';draftEdits.clear();ideaEdits.clear();ideaModes.clear();}stateETag=response.headers?.get('ETag')||'';pollRetryAt=0;await migrateFollowerHistory();render();if(initial){for(const [id,key] of [['personality-input','personality'],['knowledge-input','knowledge'],['examples-input','examples'],['reply-policy-input','replyPolicy'],['mode-input','mode'],['interval-input','intervalSeconds'],['comment-delay-input','commentDelaySeconds'],['posts-input','postIds'],['page-input','pageId'],['version-input','graphVersion']])$('#'+id).value=key==='replyPolicy'&&state.settings.replyPolicyPageId!==state.settings.pageId?'':state.settings[key]??'';$('#skip-emoji-input').checked=state.settings.replyPolicyPageId===state.settings.pageId&&!!state.settings.skipEmojiOnly;fillReplyAI();toTop();}applyVisitorAccess();}finally{loading=false;}}
// After the first load draws, undo the browser's jump to the #screen anchor so the Page header stays in view.
function toTop(){window.scrollTo?.(0,0);window.requestAnimationFrame?.(()=>window.scrollTo?.(0,0));setTimeout(()=>window.scrollTo?.(0,0),300);}

// ---------- Inbox interactions ----------
function showTest(){if(!state||state.readOnly)return;location.hash='#queue';nav();$('#test-form').hidden=false;$('#test-form textarea[name="message"]').focus();}
function hideTest(){$('#test-form').hidden=true;$('#open-test').focus();}
// Menu links are #anchors; the browser would jump past the Page header, so each screen opens at the top.
if('scrollRestoration' in history)history.scrollRestoration='manual';
window.addEventListener('hashchange',()=>{nav();window.scrollTo?.(0,0);});nav();

$('#open-test').onclick=showTest;$('#close-test').onclick=hideTest;
$('#comment-rows').addEventListener('click',event=>{const row=event.target.closest('[data-row]');if(row)selectComment(row.dataset.row,{open:true,scroll:false});});
let publishingConfirmation=null;
function confirmPublishing(comment,reply){
  if(publishingConfirmation)return Promise.resolve(false);
  const dialog=$('#publish-dialog');dialog.returnValue='';
  $('#publish-recipient').textContent=comment.author||'Facebook commenter';
  $('#publish-preview').textContent=reply;
  return new Promise(resolve=>{
    publishingConfirmation={resolve,id:comment.id,returnFocus:document.activeElement};
    dialog.showModal();$('#publish-cancel').focus();
  });
}
$('#publish-cancel').onclick=$('#publish-close').onclick=()=>$('#publish-dialog').close('cancel');
$('#publish-confirm').onclick=()=>$('#publish-dialog').close('publish');
$('#publish-dialog').addEventListener('close',()=>{
  const pending=publishingConfirmation;publishingConfirmation=null;
  if(!pending)return;
  const fallback=[...document.querySelectorAll('[data-comment]')].find(c=>c.dataset.comment===pending.id)?.querySelector('[data-action="approve"]');
  (pending.returnFocus?.isConnected?pending.returnFocus:fallback)?.focus({preventScroll:true});
  pending.resolve($('#publish-dialog').returnValue==='publish');
});
$('#comments').addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-back')){$('#workspace').dataset.pane='list';return;}
  const card=button.closest('[data-comment]');if(!card||!button.dataset.action)return;
  const id=card.dataset.comment,kind=button.dataset.action;
  let confirmedReply;
  if(kind==='approve'){
    const comment=state.comments.find(c=>c.id===id),reply=card.querySelector('[data-draft]')?.value||'';
    disarm();
    if(comment?.source==='facebook'){
      if(!await confirmPublishing(comment,reply))return;
      const current=state.comments.find(c=>c.id===id);
      if(!current||current.status!=='pending'||current.draft!==comment.draft||current.message!==comment.message){notice('This reply changed while you were reviewing it. Review the latest draft before publishing.',true);return;}
      confirmedReply=reply;
    }
  }
  disarm();
  action(button,async()=>{
    let result;
    if(kind.startsWith('resolve-'))await api('resolve-uncertain',{id,status:kind.slice(8)});
    else if(kind==='draft-personality')result=await api('draft',{id,draft:card.querySelector('[data-draft]')?.value,personalityPreset:'wine-and-silence'});
    else if(kind==='refine'){const instructions=card.querySelector('[data-idea]').value.trim();if(!instructions)throw new Error('Write your idea or instructions first.');result=await api('draft',{id,draft:card.querySelector('[data-draft]')?.value,instructions,editingMode:ideaModes.get(id)||'improve'});}
    else result=await api(kind,{id,draft:confirmedReply??card.querySelector('[data-draft]')?.value});
    draftEdits.delete(id);
    const editor=[...document.querySelectorAll('textarea[data-draft]')].find(t=>t.dataset.draft===id);
    if(editor)editor.value=editor.dataset.original;
    if(['draft','refine','draft-personality'].includes(kind)){
      await refresh();
      const current=state.comments.find(c=>c.id===id);
      if(current?.status==='pending'){
        search='';$('#comment-search').value='';setFilter('pending');selectComment(id,{open:true,scroll:false});
        notice(current.draft?'Draft ready for your approval.':'Follow-up is awaiting your decision. AI did not suggest a reply.');
      }else if(result?.skipped||current?.status==='skipped')notice('No reply generated: '+(result?.reason||current?.reason||'The AI could not find a meaningful response.'),true);
      else if(current?.error)notice(current.error,true);
    }
  },kind==='approve'?'Reply handled. Check its status in the inbox.':['draft','refine','draft-personality'].includes(kind)?'':'Comment updated.');
});
function setFilter(key){
  if(state?.readOnly)return;
  filter=key;
  document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.filter===key)));
  renderComments();
}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{
  if(b.classList.contains('kpi')){search='';$('#comment-search').value='';location.hash='#queue';nav();$('#workspace').dataset.pane='list';}
  setFilter(b.dataset.filter);
});
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
$('#test-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('test-comment',Object.fromEntries(new FormData(event.target)));event.target.reset();$('#test-form').hidden=true;},'Test comment added. The AI will draft a reply automatically when your Hugging Face Space is connected.');};
$('#facebook-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('facebook/save',Object.fromEntries(new FormData(event.target)));event.target.elements.pageToken.value='';event.target.elements.appSecret.value='';},'Facebook settings saved. Verify the Page connection before publishing.');};
$('#verify-fb').onclick=()=>action($('#verify-fb'),async()=>{const page=await api('facebook/verify');notice('Verified Facebook Page: '+page.name);});
$('#subscribe-fb').onclick=()=>action($('#subscribe-fb'),()=>api('facebook/subscribe'),'Page subscribed. Finish configuring the feed webhook in Meta.');
$('#copy-token').onclick=()=>action($('#copy-token'),()=>navigator.clipboard.writeText($('#verify-token').value),'Verify token copied.');

// Live On/Off: only one Socialite app (this PC or Cloudflare) works at a time.
function renderLive(){
  const live=state.live||{on:false}, sw=$('#live-switch');
  sw.setAttribute('aria-checked',String(live.on));
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

// ---------- Keyboard: J/K move, E edit, R regenerate, A approve (press twice), / search, Ctrl+K palette ----------
let armed=null,armTimer;
function disarm(){clearTimeout(armTimer);armed?.classList.remove('is-armed');armed=null;}
function approveSelected(){
  const button=currentDetail()?.querySelector('[data-action="approve"]');
  if(!button){notice('Select a reply that is awaiting approval first.',true);return;}
  if(armed===button){disarm();button.click();return;}
  disarm();armed=button;button.classList.add('is-armed');notice('Press A again to open the publishing confirmation.');
  armTimer=setTimeout(disarm,2000);
}
document.addEventListener('keydown',event=>{
  if(!state||state.readOnly)return;
  if($('#cloudflare-dialog').open||$('#publish-dialog').open||$('#earnings-dialog').open)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openPalette();return;}
  if(event.key==='Escape'){if(!$('#palette').hidden)return closePalette();if(!$('#test-form').hidden)return hideTest();disarm();return;}
  if(!$('#palette').hidden||typing(event.target)||event.ctrlKey||event.metaKey||event.altKey)return;
  const inbox=!$('#queue').hidden, key=event.key.toLowerCase();
  if(key==='/'){event.preventDefault();location.hash='#queue';$('#comment-search').focus();return;}
  if(!inbox)return;
  const inList=!!event.target.closest?.('#comment-rows');
  if(key==='j'||(event.key==='ArrowDown'&&inList)){event.preventDefault();moveSelection(1);if(inList)[...document.querySelectorAll('#comment-rows [data-row]')].find(r=>r.dataset.row===selected)?.focus();}
  else if(key==='k'||(event.key==='ArrowUp'&&inList)){event.preventDefault();moveSelection(-1);if(inList)[...document.querySelectorAll('#comment-rows [data-row]')].find(r=>r.dataset.row===selected)?.focus();}
  else if(key==='e'){const d=currentDetail();const t=d?.querySelector('[data-draft]:not([readonly])')||d?.querySelector('[data-idea]:not([disabled])');if(t){event.preventDefault();$('#workspace').dataset.pane='detail';t.focus();}}
  else if(key==='r'){const b=currentDetail()?.querySelector('[data-action="draft"]');if(b){event.preventDefault();b.click();}}
  else if(key==='a'){event.preventDefault();approveSelected();}
});

// ---------- Command palette ----------
const commands=()=>[
  ['Go to Inbox','',()=>{location.hash='#queue';}],
  ['Go to Voice & rules','',()=>{location.hash='#personality';}],
  ['Go to Connections','',()=>{location.hash='#connections';}],
  ['Go to Activity','',()=>{location.hash='#activity';}],
  [state?.live?.on?'Turn agent Live Off':'Turn agent Live On','',()=>setLive(!(state.live?.on))],
  ['Playground','',()=>{location.hash='#queue';showTest();}],
  ['Search comments','/',()=>{location.hash='#queue';$('#comment-search').focus();}],
  ...Object.entries(tabLabels).map(([key,label])=>['Show: '+label,'',()=>{location.hash='#queue';setFilter(key);}]),
  ['Verify Facebook Page','',()=>{location.hash='#connections';$('#verify-fb').click();}],
  ['Copy webhook verify token','',()=>$('#copy-token').click()],
  ['Sign out','',()=>$('#sign-out').click()],
];
let paletteItems=[],paletteIndex=0,paletteReturn=null;
function renderPalette(){
  const q=$('#palette-input').value.toLowerCase().trim();
  paletteItems=commands().filter(([label])=>!q||label.toLowerCase().includes(q));
  paletteIndex=Math.min(paletteIndex,Math.max(0,paletteItems.length-1));
  $('#palette-list').innerHTML=paletteItems.length?paletteItems.map(([label,hint],i)=>`<li role="option" id="cmd-${i}" data-cmd="${i}" aria-selected="${i===paletteIndex}"><span>${esc(label)}</span>${hint?`<small>${esc(hint)}</small>`:''}</li>`).join(''):'<li class="none">No matching command</li>';
  $('#palette-input').setAttribute('aria-activedescendant',paletteItems.length?'cmd-'+paletteIndex:'');
}
function openPalette(){paletteReturn=document.activeElement;$('#palette').hidden=false;$('#palette-input').value='';paletteIndex=0;renderPalette();$('#palette-input').focus();}
function closePalette(){$('#palette').hidden=true;paletteReturn?.focus?.();}
function runCommand(i){const item=paletteItems[i];if(!item)return;$('#palette').hidden=true;item[2]();}
$('#open-palette').onclick=openPalette;
$('#palette-input').addEventListener('input',()=>{paletteIndex=0;renderPalette();});
$('#palette-input').addEventListener('keydown',event=>{
  if(event.key==='ArrowDown'){event.preventDefault();paletteIndex=Math.min(paletteItems.length-1,paletteIndex+1);renderPalette();document.getElementById('cmd-'+paletteIndex)?.scrollIntoView({block:'nearest'});}
  else if(event.key==='ArrowUp'){event.preventDefault();paletteIndex=Math.max(0,paletteIndex-1);renderPalette();document.getElementById('cmd-'+paletteIndex)?.scrollIntoView({block:'nearest'});}
  else if(event.key==='Enter'){event.preventDefault();runCommand(paletteIndex);}
  else if(event.key==='Tab'){event.preventDefault();}
});
$('#palette-list').addEventListener('click',event=>{const li=event.target.closest('[data-cmd]');if(li)runCommand(Number(li.dataset.cmd));});
$('#palette').addEventListener('click',event=>{if(event.target.id==='palette')closePalette();});

await refresh(true).catch(error=>notice(error.message,true));
function fillReplyAI(){
  const selected=document.querySelector(`input[name="aiProvider"][value="${state.settings.aiProvider||'fallback'}"]`);
  if(selected)selected.checked=true;
  $('#hf-space-input').value=state.settings.hfSpace||'';
  if(state.settings.model){const option=document.createElement('option');option.value=state.settings.model;option.textContent=state.settings.model;$('#model-select').replaceChildren(option);}
  $('#save-model').disabled=!state.chatgpt?.enabled||!$('#model-select').value;
  showReplyAIFields();
}
function showReplyAIFields(){
  const provider=document.querySelector('input[name="aiProvider"]:checked')?.value;
  const usesHF=provider!=='chatgpt';
  $('#hf-fields').hidden=!usesHF;
  $('#check-hf').hidden=!usesHF;
}
document.querySelectorAll('input[name="aiProvider"]').forEach(radio=>radio.onchange=showReplyAIFields);
$('#check-hf').onclick=()=>action($('#check-hf'),async()=>{
  await api('settings',Object.fromEntries(new FormData($('#ai-provider-form'))));$('#hf-token-input').value='';
  await api('huggingface/check');
},'Your Hugging Face Space is connected and ready.');
$('#load-models').onclick=()=>action($('#load-models'),async()=>{
  const {models}=await api('chatgpt/check');
  const select=$('#model-select'),current=select.value||state.settings.model;
  select.replaceChildren();
  for(const model of models||[]){const option=document.createElement('option');option.value=model.id;option.textContent=model.name;select.append(option);}
  if([...select.options].some(option=>option.value===current))select.value=current;
  $('#save-model').disabled=!select.value;
},'ChatGPT models loaded.');
$('#model-select').onchange=()=>{$('#save-model').disabled=!$('#model-select').value;};
$('#save-model').onclick=()=>action($('#save-model'),()=>api('settings',{model:$('#model-select').value}),'ChatGPT reply model saved.');
$('#disconnect-chatgpt').onclick=()=>action($('#disconnect-chatgpt'),()=>api('chatgpt/disconnect'),'Copied ChatGPT session removed from the online app.');
$('#ai-provider-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('settings',Object.fromEntries(new FormData(event.target)));$('#hf-token-input').value='';},'Reply AI choice saved. New drafts will use the selected provider.');};
$('#connect-webhook').onclick=()=>setLive(!(state.live?.on));
$('#copy-webhook').onclick=()=>action($('#copy-webhook'),()=>navigator.clipboard.writeText($('#webhook-address').value),'Webhook address copied.');
$('#password-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('password',Object.fromEntries(new FormData(event.target)));location.replace('/login');});};
$('#sign-out').onclick=async()=>{if(!state||state.readOnly)return;await fetch('/api/logout',{method:'POST'}).catch(()=>{});location.replace('/');};
function renderCloudflare(){
  const u=cloudflareUsage,available=!!u?.available,percent=(n,limit)=>(100*n/limit).toFixed(1)+'%';
  const peak=available?Math.max(u.reads/u.readLimit,u.writes/u.writeLimit):0;
  $('#cf-status').textContent=!u?'Loading':!available?'Unavailable':u.stale?'Stale':peak>=1?'Limit reached':peak>=.8?'Near limit':'Healthy';
  $('#cf-status').dataset.level=!available||u.stale?'quiet':peak>=1?'error':peak>=.8?'warn':'ok';
  $('#cf-reads').textContent=available?percent(u.reads,u.readLimit):'—';
  $('#cf-writes').textContent=available?percent(u.writes,u.writeLimit):'—';
  const reset=u?.resetAt;
  $('#cf-reset').textContent='Resets at 8 AM SGT';
  $('#cf-details').innerHTML=available?[['Rows read',u.reads,u.readLimit],['Rows written',u.writes,u.writeLimit]].map(([label,n,limit])=>`<div class="cf-detail"><div class="cf-row"><span>${label}</span><strong class="mono">${percent(n,limit)}</strong></div><progress max="${limit}" value="${Math.min(n,limit)}" aria-label="${label} daily allowance"></progress><small class="mono">${n.toLocaleString()} / ${limit.toLocaleString()} · ${Math.max(0,limit-n).toLocaleString()} remaining</small></div>`).join(''):`<p class="hint">${esc(u?.error||'Loading usage…')}</p>`;
  $('#cf-updated').textContent=(available?(u.stale?'Last successful update: ':'Updated: ')+new Date(u.updatedAt).toLocaleString()+'. ':'')+(reset?'Next reset: '+new Date(reset).toLocaleString('en-SG',{timeZone:'Asia/Singapore',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' SGT. ':'')+'Usage refreshes every 5 minutes.';
  $('#open-cloudflare').title=available?`Daily account usage: reads ${u.reads.toLocaleString()}, writes ${u.writes.toLocaleString()}. Click for limits and remaining allowance.`:(u?.error||'Loading Cloudflare usage.');
}
async function refreshCloudflare(){
  if(state?.readOnly){cloudflareUsage=state.cloudflare;renderCloudflare();return;}
  if(!state||document.hidden||cloudflareLoading||Date.now()<cloudflareNextAt)return;
  cloudflareLoading=true;cloudflareNextAt=Date.now()+300000;
  try{
    const response=await fetch('/api/cloudflare');if(!response.ok)throw Error('Cloudflare usage is temporarily unavailable.');
    cloudflareUsage=await response.json();
  }catch(error){cloudflareUsage=cloudflareUsage?.available?{...cloudflareUsage,stale:true}:{available:false,error:error.message};}
  finally{cloudflareLoading=false;renderCloudflare();}
}
$('#open-cloudflare').onclick=()=>{$('#cloudflare-dialog').showModal();renderCloudflare();refreshCloudflare();};
$('#close-cloudflare').onclick=()=>$('#cloudflare-dialog').close();
$('#cloudflare-dialog').addEventListener('close',()=>$('#open-cloudflare').focus());
function clearEarnings(){
  $('#earnings-total').textContent='—';$('#earnings-detail-total').textContent='—';$('#earnings-status').textContent='';$('#earnings-days').replaceChildren();
  $('#earnings-card').dataset.status='loading';$('#earnings-card').title='';$('#earnings-card').setAttribute('aria-label','Approximate earnings. Open earnings details.');
  $('#earnings-month').textContent='This month · Estimate';$('#earnings-period').textContent='This month';
}
function showEarningsError(message,label='Update unavailable'){
  const card=$('#earnings-card'),hasAmount=$('#earnings-total').textContent!=='—';
  $('#earnings-status').textContent=message+(hasAmount?' Showing the last fetched estimate.':'');
  card.dataset.status='error';$('#earnings-month').textContent=label;card.title=$('#earnings-status').textContent;
  card.setAttribute('aria-label',(hasAmount?$('#earnings-total').textContent+'. Last fetched estimate. ':'Approximate earnings unavailable. ')+message);
}
async function refreshEarnings(force=false){
  if(!state||state.readOnly||document.hidden||earningsLoading)return;
  const page=state.settings.pageId;
  if(page!==earningsPage){earningsNextAt=0;earningsPage=page;clearEarnings();}
  if(!force&&Date.now()<earningsNextAt)return;
  earningsLoading=true;earningsNextAt=Date.now()+5*60*1000;
  $('#earnings-refresh').disabled=true;$('#earnings-refresh').setAttribute('aria-busy','true');
  try{
    const response=await fetch('/api/earnings'+(force?'?refresh=1':''),{cache:'no-store'});
    if(response.status===401){await refresh();return;}
    if(!response.ok)throw Error('Cannot load earnings right now.');
    const data=await response.json();
    if(state.readOnly||state.settings.pageId!==page)return;
    earningsNextAt=Date.now()+(data.retryAfterSeconds||(!data.available?60:300))*1000;
    if(!data.available){showEarningsError(data.error||'Earnings are not available yet.',data.errorCode===190?'Reconnect Facebook':'Update unavailable');return;}
    clearEarnings();
    const formatter=new Intl.NumberFormat('en-SG',data.currency?{style:'currency',currency:data.currency,currencyDisplay:'code'}:{minimumFractionDigits:2,maximumFractionDigits:2}),money=amount=>formatter.format(amount);
    $('#earnings-period').textContent=data.periodLabel||'This month';
    $('#earnings-month').textContent=(data.periodLabel||'This month').replace(/ earnings$/i,'')+' · Estimate';
    const tileFormatter=new Intl.NumberFormat('en-SG',data.currency?{style:'currency',currency:data.currency,currencyDisplay:'narrowSymbol'}:{minimumFractionDigits:2,maximumFractionDigits:2});
    $('#earnings-total').innerHTML=tileFormatter.formatToParts(data.amount).map(part=>part.type==='currency'?'<span class="money-currency">'+esc(part.value)+'</span>':esc(part.value)).join('');
    $('#earnings-detail-total').textContent=money(data.amount);$('#earnings-card').dataset.status='ready';
    $('#earnings-card').setAttribute('aria-label',(data.periodLabel||'This month')+': '+money(data.amount)+' approximate earnings. Open daily breakdown.');
    const stamp=at=>new Date(at).toLocaleString('en-SG',{timeZone:'Asia/Singapore',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    $('#earnings-status').textContent='Latest reported day ending '+stamp(data.endAt)+' SGT · '+data.values.length+' daily '+(data.values.length===1?'entry':'entries')+' · Updated '+stamp(data.updatedAt)+' SGT'+(data.warning?' · '+data.warning:'');
    const max=Math.max(...data.values.map(row=>Math.abs(row.amount)),.01);
    for(const row of data.values){const bar=document.createElement('span');bar.className='earnings-day';bar.tabIndex=0;bar.style.height=Math.max(2,Math.abs(row.amount)/max*64)+'px';bar.title='Day ending '+stamp(row.endAt)+' SGT: '+money(row.amount);bar.setAttribute('aria-label',bar.title);$('#earnings-days').append(bar);}
  }catch(error){earningsNextAt=Date.now()+60000;if(state&&!state.readOnly&&state.settings.pageId===page)showEarningsError(error.message);}
  finally{earningsLoading=false;$('#earnings-refresh').disabled=!!state?.readOnly;$('#earnings-refresh').removeAttribute('aria-busy');}
}
$('#earnings-refresh').onclick=()=>refreshEarnings(true);
$('#earnings-card').onclick=()=>{if(!state||state.readOnly)return;$('#earnings-dialog').showModal();refreshEarnings();};
$('#close-earnings').onclick=()=>$('#earnings-dialog').close();
$('#earnings-dialog').addEventListener('close',()=>{if(state&&!state.readOnly)$('#earnings-card').focus();});
async function pollDashboard(){if(visitorMode&&Date.now()<visitorNextAt)return;if(document.hidden||Date.now()<pollRetryAt)return;await refresh().catch(error=>notice(error.message,true));if(Date.now()>=pollRetryAt)await Promise.all([refreshCloudflare(),refreshEarnings()]);}
setInterval(pollDashboard,5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollDashboard();});
refreshCloudflare();
refreshEarnings();
