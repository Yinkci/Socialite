let state, filter='all', loading=false, search='', selected=null;
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
const isNewComment=c=>['queued','generating','pending','publishing'].includes(c.status);
const isPublishedFilter=()=>['published','approved','automatic'].includes(filter);
const publicationLabel=c=>c.publish_kind==='automatic'?'Automatically published':['approved','edited'].includes(c.publish_kind)?'Approved by you':'Publication method unavailable';
const needsAttention=c=>!['published','removed','skipped'].includes(c.status)&&(['error','uncertain'].includes(c.status)||['error','uncertain'].includes(c.reaction_status));
const tabLabels={all:'All comments',new:'New comments',pending:'Awaiting approval',published:'All published',approved:'Approved by you',automatic:'Automatically published',error:'Needs attention',rejected:'Dismissed replies',skipped:'No reply needed'};
const segLabels={new:'New',pending:'Awaiting',published:'Published',error:'Attention'};
const moreLabels={all:'All',approved:'By you',automatic:'Auto',rejected:'Dismissed',skipped:'No reply'};
const matchesTab=(c,key)=>c.status!=='removed'&&!c.cleared_at&&(key==='all'?!['published','rejected','skipped'].includes(c.status):key==='new'?isNewComment(c):key==='error'?needsAttention(c):key==='approved'?c.status==='published'&&['approved','edited'].includes(c.publish_kind):key==='automatic'?c.status==='published'&&c.publish_kind==='automatic':c.status===key);
const date=(at,seconds=false)=>new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{})});
const ago=at=>{const s=Math.max(0,Math.round((Date.now()-at)/1000));return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':s<86400?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago';};
// Status tone shared by list dots and the status pill: waiting on you, posted, needs attention, or quiet.
const tone=status=>['published','simulated'].includes(status)?'sent':['pending','queued','generating','publishing'].includes(status)?'wait':['error','uncertain'].includes(status)?'warn':'quiet';
const seenStatus=new Map(), renderedRows=new Set();
// Last markup written to the list and the conversation pane: unchanged markup is not rewritten,
// so the 5-second refresh never resets scroll, hover or the opening animation.
let lastRowsHtml='', lastDetailHtml='';
const typing=el=>!!el&&(el.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(el.tagName));

let noticeTimer;
function notice(message,error=false){const n=$('#notice');n.textContent=message;n.dataset.tone=error?'fault':'ok';n.hidden=false;clearTimeout(noticeTimer);if(!error)noticeTimer=setTimeout(()=>{n.hidden=true;},6000);}
async function api(path,input={}) {
  const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(input)});
  if(response.status===401){location.replace('/login');throw new Error('Please sign in.');}
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
async function action(button,fn,message) {
  // Buttons that hold live data (the agent switch: its label and last-activity time) keep their content; others show Working….
  const keep=!!button.querySelector('[id]'), original=button.innerHTML;
  button.disabled=true;if(keep)button.setAttribute('aria-busy','true');else button.textContent='Working…';
  try {await fn();if(message)notice(message);await refresh();} catch(error){notice(error.message,true);} finally{button.disabled=button.id==='memory-clear'&&!state.memory?.total;button.removeAttribute('aria-busy');if(button.id==='memory-toggle')button.textContent=(state.memory?.enabled??true)?'Turn learning off':'Turn learning on';else if(!keep)button.innerHTML=original;if(button.id==='clear-comment-history')renderComments();}
}
function nav(){const section=['queue','personality','connections','activity'].includes(location.hash.slice(1))?location.hash.slice(1):'queue';document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==section);document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===section)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});if(section==='personality'&&state)renderMemory();$('#section-label').textContent={queue:'Comment inbox',personality:'AI personality',connections:'Connections',activity:'Activity'}[section];}

// ---------- Inbox: list | thread | reply ----------
function visibleRows(){
  const rows=state.comments.filter(c=>matchesTab(c,filter)&&(!search||[c.author,c.message,c.context,c.draft].some(value=>String(value||'').toLowerCase().includes(search))));
  if(isPublishedFilter())rows.sort((a,b)=>(b.published_at||b.created_at)-(a.published_at||a.created_at));
  return rows;
}
function renderFilters(){
  document.querySelectorAll('[data-filter]').forEach(button=>{
    const key=button.dataset.filter,count=state.tabCounts?.[key]??state.comments.filter(c=>matchesTab(c,key)).length;
    button.innerHTML=`${esc(segLabels[key]&&button.closest('.seg')?segLabels[key]:tabLabels[key])} <span class="n"><span class="p">(</span>${count.toLocaleString()}<span class="p">)</span></span>`;
  });
  const inMenu=!!$(`#filter-menu [data-filter="${filter}"]`);
  $('#filter-more-label').textContent=inMenu?moreLabels[filter]:'More';$('#filter-more').title=inMenu?'Showing: '+tabLabels[filter]:'More filters';
  $('#filter-more').dataset.active=String(inMenu);
}
function renderComments() {
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
    return `<button type="button" class="row" role="option" data-row="${esc(c.id)}" aria-selected="${c.id===selected}"><span class="row-dot" data-tone="${tone(c.status)}" aria-hidden="true"></span><span class="row-who">${esc(c.author||'Facebook user')}</span><time class="row-time" datetime="${new Date(c.created_at).toISOString()}">${ago(c.created_at)}</time><span class="row-text">${esc(preview)}</span><span class="row-state">${c.source==='test'?'Test, ':''}${esc(labels[c.status]||c.status)}</span></button>`;
  }).join('');
  if(rowsHtml!==lastRowsHtml){$('#comment-rows').innerHTML=rowsHtml;lastRowsHtml=rowsHtml;}
  // Newly arrived rows slide in once, staggered; existing rows never re-animate.
  fresh.forEach((id,i)=>{const r=[...document.querySelectorAll('#comment-rows [data-row]')].find(r=>r.dataset.row===id);if(r){r.style.setProperty('--i',i);r.classList.add('enter');r.addEventListener('animationend',()=>r.classList.remove('enter'),{once:true});}renderedRows.add(id);});

  const detailHtml=rows.length?rows.map(c=>{
    const fbUrl='https://www.facebook.com/'+encodeURIComponent(c.post_id||'');
    const postUrl=safeUrl(c.post_url,fbUrl);
    const imageUrl=safeUrl(c.post_image,'');
    const statusIcon=['published','simulated'].includes(c.status)?'check':['error','uncertain'].includes(c.status)?'alert':['pending','queued','generating'].includes(c.status)?'wait':'msg';
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
    const controls=`${editable?`<button type="button" class="btn btn-accent" data-action="approve">${icon('send')}${c.source==='test'?'Approve test reply':'Approve & publish reply'}<kbd>A</kbd></button>`:''}${['queued','pending','error'].includes(c.status)?`<button type="button" class="btn" data-action="draft">${icon('again')}${c.draft?'Regenerate reply':'Generate reply'}<kbd>R</kbd></button><button type="button" class="btn btn-ghost btn-danger" data-action="reject">Dismiss reply</button>`:''}${['rejected','skipped'].includes(c.status)?`<button type="button" class="btn" data-action="draft">${icon('again')}Generate new reply<kbd>R</kbd></button>`:''}${c.status==='uncertain'?'<button type="button" class="btn" data-action="resolve-published">I checked: reply was posted</button><button type="button" class="btn" data-action="resolve-pending">I checked: no reply was posted</button>':''}`;
    return `<article class="convo" data-comment="${esc(c.id)}" aria-label="Conversation with ${esc(c.author||'Facebook user')}" ${c.id===selected?'':'hidden'}>
      <div class="convo-thread">
        <header class="convo-head"><button type="button" class="btn btn-ghost back" data-back>${icon('back')}Back</button><span class="convo-from">${icon(c.source==='test'?'flask':'msg')}${c.source==='test'?'Test conversation':'Facebook conversation'}</span><time datetime="${new Date(c.created_at).toISOString()}">Received: ${date(c.created_at,true)}</time><span class="state${landed?' landed':''}" data-tone="${tone(c.status)}">${icon(statusIcon)}${c.status==='published'?(c.publish_kind==='automatic'?'Automatically published':'Published'):labels[c.status]||esc(c.status)}</span></header>
        <section class="post${imageUrl&&c.source==='facebook'?'':' post-noimg'}" aria-label="Post context">
          ${imageUrl&&c.source==='facebook'?`<a href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer"><img class="post-img" src="${esc(imageUrl)}" alt="Facebook post preview" loading="lazy" width="96" height="96"></a>`:''}
          <div class="post-body"><h3 class="sec-h">${c.source==='test'?'Test post context':'Your Facebook post / Reel'}</h3><div class="post-text">${esc(postCaption)}</div>${c.source==='facebook'?`<a class="ext" href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer">Open post on Facebook ${icon('ext')}</a>`:'<span class="test-tag">Local test. Nothing posts to Facebook.</span>'}</div>
        </section>
        <section class="said" aria-label="Customer comment"><h3 class="sec-h">Customer comment</h3><div class="who"><span class="avatar" aria-hidden="true">${esc((c.author||'F').slice(0,1).toUpperCase())}</span><strong>${esc(c.author||'Facebook user')}</strong><span>commented</span></div><blockquote class="said-text">${esc(c.message)}</blockquote></section>
        ${like}
      </div>
      <section class="convo-reply${posted?' is-posted':''}" aria-label="${replyTitle}">
        <div class="reply-h"><h3>${c.draft?replyTitle:'Your reply'}</h3><span class="reply-flag">${c.status==='generating'?'Generating&hellip;':posted?'Sent':editable?'Not published':'Not sent'}</span></div>
        ${c.source==='facebook'&&['queued','generating','pending'].includes(c.status)&&c.created_at+(state.settings.commentDelaySeconds||0)*1000>Date.now()?`<p class="note"><strong>Minimum comment delay:</strong> This reply can publish after ${date(c.created_at+state.settings.commentDelaySeconds*1000,true)}. Drafting and editing can happen now.</p>`:''}
        ${c.status==='published'?`<p class="reply-meta">${publicationLabel(c)}.${c.published_at?' Published at '+date(c.published_at,true)+'.':''}${c.publish_kind==='edited'?' You edited this reply before approving.':''}</p>`:''}
        ${c.status==='skipped'?`<p class="note"><strong>No reply needed:</strong> ${esc(c.reason||'This comment has no clear message to respond to.')} No reply will be published. You can reassess it manually; any restored draft will wait for your approval.</p>`:''}
        ${c.status==='pending'&&c.reply_decision==='REVIEW'?'<p class="note"><strong>Meaning needs review:</strong> This reply needs your approval, including in Automatic mode.</p>':''}
        ${c.status==='rejected'?'<p class="guide">This reply was dismissed. You can generate a new reply whenever you want; it will wait for your approval.</p>':''}
        ${c.draft?`<div class="draft">${c.status==='generating'?'<p class="guide">AI is working on your reply. The previous draft is shown until it is ready.</p>':''}${editable?'<p class="guide">Edit the reply, then approve it to publish.</p>':''}<textarea aria-label="Reply to ${esc(c.author)}" data-draft="${esc(c.id)}" data-original="${esc(c.draft)}" rows="6" maxlength="1000" ${editable?'':'readonly'}>${esc(editable?(draftEdits.get(c.id)?.text??c.draft):c.draft)}</textarea>${c.reason?`<p class="note"><strong>Review note:</strong> ${esc(c.reason)}</p>`:''}</div>`:`<p class="empty-reply">${c.status==='generating'?'AI is writing a reply. It will appear here shortly.':c.status==='queued'?(state.replyAI?.enabled?'Waiting for automatic drafting. Replies are generated one at a time.':'Connect your Hugging Face Space to generate this reply automatically.'):'No reply has been generated for this comment.'}</p>`}
        ${c.error?`<p class="fault"><strong>Needs attention:</strong> ${esc(c.error)}</p>`:''}
        ${controls?`<div class="actions">${controls}</div>`:''}
        ${['queued','pending','error','rejected','skipped','generating'].includes(c.status)?`<div class="coach"><label class="coach-title" for="idea-${esc(c.id)}">Work on this reply with AI</label><p>${grammarOnly?'Paste your reply below. AI will only correct spelling, grammar, and punctuation, preserving your meaning and tone.':'Share your idea or tell the AI what to change. It will use this comment, the post, and your current draft.'}</p><label class="coach-pick">What should AI do?<select data-idea-mode="${esc(c.id)}" aria-label="AI editing mode for ${esc(c.author)}" ${c.status==='generating'?'disabled':''}><option value="improve" ${!grammarOnly?'selected':''}>Improve my idea</option><option value="grammar" ${grammarOnly?'selected':''}>Correct grammar only</option></select></label><textarea id="idea-${esc(c.id)}" data-idea="${esc(c.id)}" aria-label="Your idea for replying to ${esc(c.author)}" rows="2" maxlength="${grammarOnly?1000:2000}" placeholder="${grammarOnly?'Type the exact reply you want corrected.':'For example: Say I appreciate their support, but make it sound more personal.'}" ${c.status==='generating'?'disabled':''}>${esc(ideaEdits.get(c.id)||'')}</textarea><div class="coach-f"><span>Creates a draft for your approval.</span><button type="button" class="btn" data-action="refine" ${c.status==='generating'?'disabled':''}>${icon('spark')}${grammarOnly?'Correct grammar':'Write reply from my idea'}</button></div></div>`:''}
      </section></article>`;
  }).join(''):`<div class="listening"><div class="radar${state.live?.on?'':' idle'}" aria-hidden="true"></div><h2>${search?'No matching conversations.':filter==='all'?(state.live?.on?'Agent listening…':'Agent is off.'):'All caught up.'}</h2><p>${search?'Try another name, comment, or phrase.':filter==='all'?(state.live?.on?'New comments appear here the moment Facebook sends them. Try a test comment to hear your AI voice.':'Turn Live On to receive new comments, or try a test comment.'):'New conversations matching this filter will appear here.'}</p><button type="button" id="empty-test" class="btn">New test comment</button></div>`;
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

// ---------- KPIs: counts, 24h deltas, 12h sparklines ----------
function sparkline(svg,times){
  const now=Date.now(),hour=3600e3,buckets=Array(12).fill(0);
  for(const t of times){const h=Math.floor((now-t)/hour);if(h>=0&&h<12)buckets[11-h]++;}
  const max=Math.max(1,...buckets);
  svg.innerHTML=buckets.map((n,i)=>`<rect x="${i*8}" y="${24-Math.max(2,Math.round(n/max*22))}" width="6" height="${Math.max(2,Math.round(n/max*22))}" rx="1"${i===11?' class="now"':''}/>`).join('');
}
function renderKpis(){
  const day=Date.now()-86400e3, cs=state.comments;
  const sets={new:cs.filter(isNewComment).map(c=>c.created_at),pending:cs.filter(c=>c.status==='pending').map(c=>c.created_at),published:cs.filter(c=>c.status==='published').map(c=>c.published_at||c.updated_at||c.created_at),errors:cs.filter(needsAttention).map(c=>c.updated_at||c.created_at)};
  for(const [key,times] of Object.entries(sets)){
    sparkline($('#spark-'+key),times);
    const recent=times.filter(t=>t>=day).length;
    $('#delta-'+key).textContent=(recent?'+'+recent:'0')+' in 24h';
  }
}

function render(){
  $('#header-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
  const replyAI=state.replyAI||{provider:'huggingface',enabled:false};
  $('#rail-ai-status').textContent=replyAI.enabled?'ZeroGPU Space':'Not connected';
  $('#rail-ai-dot').dataset.on=String(!!replyAI.enabled);
  $('#provider-status').textContent=replyAI.enabled?'Connected':'Not ready';
  $('#local-saved').textContent=replyAI.enabled?'Connected to Space '+state.settings.hfSpace:'Add your Space and access token, then save.';
  $('#local-saved').className='status '+(replyAI.enabled?'ok':'bad');
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
  $('#webhook-line').textContent=webhookHere?'New comments arrive here.':live.on?'Connecting. Comments will arrive here shortly.':live.target?'Live Off. Comments currently go to your other Socialite app.':'Live Off. Comments are not received.';
  $('#webhook-line').className='status '+(webhookHere?'ok':live.on?'busy':'');
  $('#connect-webhook').textContent=live.on?'Turn Live Off':'Turn Live On';
  $('#connect-webhook').className='btn '+(live.on?'':'btn-accent');
  $('#verify-token').value=state.facebook.verifyToken;
  $('#activity-list').innerHTML=state.activity.length?state.activity.map(a=>`<div class="log-row"><time datetime="${new Date(a.at).toISOString()}">${date(a.at,true)}</time><span>${esc(a.message)}</span></div>`).join(''):'<p>Activity will appear here.</p>';
  $('#agent-last').textContent=state.activity[0]?'Active '+ago(state.activity[0].at):'No activity yet';
  renderKpis();renderComments();renderMemory();renderLive();
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
async function refresh(initial=false){if(loading)return;loading=true;try{state=await fetch('/api/state').catch(()=>{throw new Error('Cannot reach Socialite. Check your internet connection.');}).then(r=>{if(r.status===401){location.replace('/login');throw new Error('Please sign in.');}if(!r.ok)throw new Error('Cannot load dashboard');return r.json();});render();if(initial){for(const [id,key] of [['personality-input','personality'],['knowledge-input','knowledge'],['examples-input','examples'],['reply-policy-input','replyPolicy'],['mode-input','mode'],['interval-input','intervalSeconds'],['comment-delay-input','commentDelaySeconds'],['posts-input','postIds'],['page-input','pageId'],['version-input','graphVersion']])$('#'+id).value=key==='replyPolicy'&&state.settings.replyPolicyPageId!==state.settings.pageId?'':state.settings[key]??'';$('#skip-emoji-input').checked=state.settings.replyPolicyPageId===state.settings.pageId&&!!state.settings.skipEmojiOnly;fillReplyAI();}}finally{loading=false;}}

// ---------- Inbox interactions ----------
function showTest(){$('#test-form').hidden=false;$('#test-form textarea[name="message"]').focus();}
function hideTest(){$('#test-form').hidden=true;$('#open-test').focus();}
window.addEventListener('hashchange',nav);nav();
$('#open-test').onclick=showTest;$('#close-test').onclick=hideTest;
$('#comment-rows').addEventListener('click',event=>{const row=event.target.closest('[data-row]');if(row)selectComment(row.dataset.row,{open:true,scroll:false});});
$('#comments').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.id==='empty-test')return showTest();
  if(button.hasAttribute('data-back')){$('#workspace').dataset.pane='list';return;}
  const card=button.closest('[data-comment]');if(!card||!button.dataset.action)return;
  const id=card.dataset.comment,kind=button.dataset.action;
  disarm();
  action(button,async()=>{
    if(kind.startsWith('resolve-'))await api('resolve-uncertain',{id,status:kind.slice(8)});
    else if(kind==='refine'){const instructions=card.querySelector('[data-idea]').value.trim();if(!instructions)throw new Error('Write your idea or instructions first.');await api('draft',{id,draft:card.querySelector('[data-draft]')?.value,instructions,editingMode:ideaModes.get(id)||'improve'});}
    else await api(kind,{id,draft:card.querySelector('[data-draft]')?.value});
    draftEdits.delete(id);
    const editor=[...document.querySelectorAll('textarea[data-draft]')].find(t=>t.dataset.draft===id);
    if(editor)editor.value=editor.dataset.original;
  },kind==='approve'?'Reply handled. Check its status in the inbox.':['draft','refine'].includes(kind)?'Drafting finished. Check the comment for its reply or error.':'Comment updated.');
});
function setFilter(key){
  filter=key;
  document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.filter===key)));
  closeMenu();renderComments();
}
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>setFilter(b.dataset.filter));
function closeMenu(){$('#filter-menu').hidden=true;$('#filter-more').setAttribute('aria-expanded','false');}
$('#filter-more').onclick=()=>{const open=$('#filter-menu').hidden;$('#filter-menu').hidden=!open;$('#filter-more').setAttribute('aria-expanded',String(open));if(open)($('#filter-menu button[aria-pressed="true"]')||$('#filter-menu button')).focus();};
document.addEventListener('click',event=>{if(!event.target.closest('.more'))closeMenu();});
$('#show-new-comments').onclick=()=>{search='';$('#comment-search').value='';location.hash='#queue';nav();$('[data-filter="new"]').click();$('#workspace').scrollIntoView({behavior:'smooth',block:'start'});};
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
  disarm();armed=button;button.classList.add('is-armed');notice('Press A again to publish this reply to Facebook.');
  armTimer=setTimeout(disarm,2000);
}
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openPalette();return;}
  if(event.key==='Escape'){if(!$('#palette').hidden)return closePalette();if(!$('#filter-menu').hidden){closeMenu();$('#filter-more').focus();return;}if(!$('#test-form').hidden)return hideTest();disarm();return;}
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
  ['New test comment','',()=>{location.hash='#queue';showTest();}],
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
setInterval(()=>refresh().catch(error=>notice(error.message,true)),5000);
