import { withoutEmDashes, isOneWordReply, isSimpleAcknowledgment } from './reply-text.js';
import { ReplyMemory } from './memory.js';
import { Reactions } from './reactions.js';
const policySkipReason=(s,c)=>s.skipEmojiOnly&&s.replyPolicyPageId===s.pageId&&(c.source==='test'||c.page_id===s.pageId)&&!/[\p{L}\p{N}]/u.test(c.message||'')&&/\p{Extended_Pictographic}/u.test(c.message||'')?'Emoji-only reaction; this Page replies to meaningful life-lesson conversations, not standalone emoji engagement.':'';
const replyKey=text=>String(text||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export class Workflow {
  constructor(store,chatgpt,facebook) { this.store=store; this.chatgpt=chatgpt; this.facebook=facebook; this.busy=false; this.publishing=false; this.lastPublish=store.lastPublished(); this.memory=new ReplyMemory(store); this.reactions=new Reactions(store,facebook); this.liking=new Set(); }
  skipComment(c,reason){
    this.store.update(c.id,{status:'skipped',reply_decision:'SKIP',draft:'',manual_hold:1,review:1,reason,error:'',attempts:0});
    if(!c.reaction_selected&&c.reaction_applied==='NONE')this.store.update(c.id,{reaction_choice:'NONE'});
    this.store.log(`No reply needed for ${c.author}.`);return {ok:true,skipped:true};
  }
  blockOneWordReply(c,draft){
    if(!isOneWordReply(draft))return false;
    if(isSimpleAcknowledgment(c.message))this.skipComment(c,'No meaningful reply needed: a one-word acknowledgment would only add repetitive engagement.');
    else this.store.update(c.id,{status:'error',manual_hold:1,review:1,draft:'',error:'AI produced a one-word or emoji-only reply. Regenerate or write a meaningful reply before publishing.'});
    return true;
  }
  checkExistingReplies(){
    for(const c of this.store.db.prepare("SELECT * FROM comments WHERE cleared_at=0 AND status='pending' AND draft<>''").all())if(isOneWordReply(c.draft))this.blockOneWordReply(c,c.draft);
  }
  applyReplyPolicy(){
    const s=this.store.settings();if(!s.skipEmojiOnly||s.replyPolicyPageId!==s.pageId)return;
    for(const c of this.store.db.prepare("SELECT * FROM comments WHERE status IN ('queued','pending','error') AND manual_hold=0").all()){const reason=policySkipReason(s,c);if(reason)this.skipComment(c,reason);}
  }
  recentPageReplies(c){
    const settings=this.store.settings();if(!settings.learningEnabled)return [];
    return this.store.db.prepare("SELECT draft FROM comments WHERE source='facebook' AND page_id=? AND status='published' AND id<>? AND draft<>'' ORDER BY COALESCE(NULLIF(published_at,0),updated_at) DESC LIMIT 6").all(settings.pageId,c.id).map(r=>r.draft);
  }
  async generate(id, previousDraft, ownerInstructions, editingMode='improve', manualRequest=false) {
    const c=this.store.get(id);
    if(c?.cleared_at)throw new Error('This conversation was cleared.');
    if(!c)return;
    if(!['queued','pending','error','rejected','skipped'].includes(c.status))throw new Error('This comment cannot be regenerated.');
    if(c.source==='facebook'&&c.page_id&&c.page_id!==this.store.settings().pageId)throw new Error('This comment belongs to a different Page. Reconnect its original Page before generating a reply.');
    if(previousDraft!==undefined&&(typeof previousDraft!=='string'||previousDraft.length>1000))throw new Error('The previous reply must be text of at most 1000 characters.');
    if(ownerInstructions!==undefined&&(typeof ownerInstructions!=='string'||ownerInstructions.length>2000))throw new Error('Your AI instructions must be text of at most 2000 characters.');
    if(!['improve','grammar'].includes(editingMode))throw new Error('Choose Improve my idea or Correct grammar only.');
    const direction=ownerInstructions?.trim()||'', grammarOnly=editingMode==='grammar';
    if(grammarOnly&&(!direction||direction.length>1000))throw new Error('Text for grammar correction must contain 1-1000 characters.');
    if(!this.store.claim(id,c.status,'generating'))return;
    if(manualRequest||['rejected','skipped'].includes(c.status)||direction)this.store.update(id,{manual_hold:1});
    try {
      if(c.source==='facebook') {
        const latest=await this.facebook.current(c);
        c.message=latest.message||'';
        c.context=await this.facebook.context(c);
        this.store.update(id,{message:c.message,context:c.context});
        if(!c.message.trim()) throw new Error('Comment has no text to reply to.');
      }
      const policyReason=!manualRequest&&!grammarOnly&&!direction?policySkipReason(this.store.settings(),c):'';
      if(policyReason)return this.skipComment(this.store.get(id),policyReason);
      let history=[];try{history=JSON.parse(c.draft_history||'[]');}catch{}
      history=[...new Set([...(Array.isArray(history)?history.filter(x=>typeof x==='string'&&x.length<=1000):[]),c.draft,previousDraft].filter(Boolean))].slice(-8);
      const previousReplies=history.map(replyKey);
      let result;
      for(let attempt=1;attempt<=(!grammarOnly&&history.length?2:1);attempt++){
        result=await this.chatgpt.generate(this.store.settings(),{...c,manualRequest,previousReplies:grammarOnly?[]:history,regenerationAttempt:attempt,ownerInstructions:direction,currentReply:previousDraft??c.draft,grammarOnly,replyMemory:grammarOnly?null:this.memory.forDraft(c),recentPageReplies:grammarOnly?[]:this.recentPageReplies(c)});
        result.reply=withoutEmDashes(result.reply);
        const current=this.store.get(id);
        if(current.status!=='generating'||current.message!==c.message)return;
        if(result.reply_decision==='SKIP'||grammarOnly||!previousReplies.includes(replyKey(result.reply)))break;
        if(attempt===2)throw new Error('AI repeated a previous reply twice. Your old draft was kept. Try regenerating again or edit the reply yourself.');
      }
      const current=this.store.get(id);
      if(current.status!=='generating'||current.message!==c.message) return;
      const decision=grammarOnly?'REPLY':(['REPLY','REVIEW','SKIP'].includes(result.reply_decision)?result.reply_decision:'REVIEW');
      if(decision==='SKIP')return this.skipComment(current,result.reason||'No meaningful reply is needed for this comment.');
      if(this.blockOneWordReply(current,result.reply))return {ok:true,skipped:this.store.get(id).status==='skipped'};
      const unclear=decision==='REVIEW';
      const sensitive=['GRIEF','POSSIBLE_DANGER'].includes(result.sensitive_context);
      const review=unclear||sensitive||current.manual_hold||result.needs_review||!c.context||/refund|complaint|scam|broken|lawsuit|angry/i.test(c.message);
      this.store.update(id,{draft:result.reply,reply_decision:decision,manual_hold:sensitive||unclear?1:current.manual_hold,draft_history:JSON.stringify([...new Set([...history,result.reply])].slice(-8)),review:review?1:0,reason:result.reason||(unclear?'Comment meaning is unclear; personal approval is required.':!c.context?'Post context is missing.':''),status:'pending',error:'',attempts:0});
      this.store.update(id,{reaction_choice:'LIKE',reaction_selected:1});
      this.store.log(`Draft ready for ${c.author}.`);
      return {ok:true};
    } catch(error) {
      if(this.store.get(id)?.status==='generating') this.store.update(id,{status:c.draft&&['pending','rejected','skipped'].includes(c.status)?c.status:'error',error:error.message});
      return {ok:false,error:error.message};
    }
  }
  async publish(id, editedDraft, automatic=false) {
    if(this.publishing) throw new Error('Another reply is being published. Please try again shortly.');
    this.publishing=true;
    try {return await this.publishOne(id,editedDraft,automatic);} finally {this.publishing=false;}
  }
  checkPublishTiming(c,settings){
    const remaining=Math.ceil((c.created_at+settings.commentDelaySeconds*1000-Date.now())/1000);
    if(remaining>0)throw new Error(`Minimum comment delay is active. This reply can publish in ${remaining} seconds.`);
    if(Date.now()-this.lastPublish<settings.intervalSeconds*1000)throw new Error('Reply spacing is active. Please try again shortly.');
  }
  async publishOne(id, editedDraft, automatic=false) {
    const c=this.store.get(id), settings=this.store.settings();
    if(!c||c.status!=='pending') throw new Error('Only pending drafts can be published.');
    if(c.source==='facebook'&&c.page_id&&c.page_id!==settings.pageId)throw new Error('This comment belongs to a different Page. Reconnect its original Page before publishing.');
    if(automatic){const reason=policySkipReason(settings,c);if(reason)return this.skipComment(c,reason);}
    if(automatic&&(settings.mode==='approval'||c.reply_decision!=='REPLY'||c.manual_hold||(settings.mode==='hybrid'&&c.review)))return;
    const publishKind=automatic?'automatic':typeof editedDraft==='string'&&editedDraft.trim()!==c.draft.trim()?'edited':'approved';
    if(typeof editedDraft==='string') {
      if(!editedDraft.trim()||editedDraft.length>1000) throw new Error('Reply must contain 1–1000 characters.');
      c.draft=editedDraft.trim();
      this.store.update(id,{draft:c.draft});
    }
    c.draft=withoutEmDashes(c.draft);
    if(c.draft.length>1000)throw new Error('Reply must contain 1?1000 characters.');
    this.store.update(id,{draft:c.draft});
    if(!c.draft.trim()) throw new Error('Generate or write a reply first.');
    if(isOneWordReply(c.draft)){
      if(automatic){this.blockOneWordReply(c,c.draft);return;}
      throw new Error('One-word and emoji-only replies are disabled. Write a meaningful reply before publishing.');
    }
    if(c.source==='test') {this.store.update(id,{status:'simulated',error:'',like_after_publish:1});await this.likePublished(id);this.store.log('Test reply and Like approved. Nothing was posted to Facebook.');return;}
    this.checkPublishTiming(c,settings);
    this.store.update(id,{publish_kind:publishKind});
    if(!this.store.claim(id,'pending','publishing')) throw new Error('Another action is already handling this reply.');
    let sent=false;
    try {
      await this.facebook.verify();
      const latest=await this.facebook.current(c);
      if(latest.message!==c.message) {this.store.update(id,{message:latest.message||'',status:'queued',draft:'',error:'Comment changed. A fresh draft is required.'});return;}
      const latestSettings=this.store.settings(), latestDraft=this.store.get(id);
      if(automatic&&(latestSettings.mode==='approval'||latestDraft.reply_decision!=='REPLY'||latestDraft.manual_hold||(latestSettings.mode==='hybrid'&&latestDraft.review)))throw new Error('Publishing preferences changed. This reply now needs your approval.');
      this.checkPublishTiming(c,latestSettings);
      this.lastPublish=Date.now(); sent=true;
      const reply=await this.facebook.publish(c);
      if(!reply.id) throw new Error('Facebook did not return a reply ID.');
      this.store.update(id,{status:'published',reply_id:reply.id,published_at:Date.now(),error:'',like_after_publish:1});
      this.store.log(`Reply published for ${c.author}.`);
    } catch(error) {
      this.store.update(id,{status:sent&&!error.definite?'uncertain':'pending',error:sent&&!error.definite?'Posting outcome unknown. Check Facebook manually before retrying.':error.message});
      throw error;
    }
    await this.likePublished(id);
    // A memory failure must never change a confirmed Facebook publication into an uncertain send.
    try{this.memory.capture(this.store.get(id),publishKind,settings.pageId);}catch{this.store.log('Reply published, but could not save its learning example.');}
  }
  async likePublished(id){
    if(this.liking.has(id)||!this.store.get(id)?.like_after_publish)return;
    this.liking.add(id);
    try{await this.reactions.afterPublication(id);}catch(error){
      const current=this.store.get(id);if(current&&!['error','uncertain'].includes(current.reaction_status))this.store.update(id,{reaction_status:'error',reaction_error:error.message});
      this.store.log('Reply published, but its Like needs checking on Facebook. The reply will not be sent again.');
    }finally{this.store.update(id,{like_after_publish:0});this.liking.delete(id);}
  }
  async loadPost() {
    const c=this.store.needsPost();
    if(!c||!this.facebook.configured()) return;
    try {
      const p=await this.facebook.post(c.post_id);
      this.store.update(c.id,{post_url:p.url||c.post_url,post_image:p.image,context:p.caption||c.context,post_loaded:1});
    } catch { this.store.update(c.id,{post_loaded:1}); }
  }
  async tick() {
    // Live Off: nothing automatic runs (no drafts, posts or Likes).
    if(this.busy||!this.store.settings().live) return;
    this.busy=true;
    try {
      const awaitingLike=this.store.db.prepare("SELECT id FROM comments WHERE like_after_publish=1 AND cleared_at=0 AND status IN ('published','simulated') LIMIT 1").get();
      if(awaitingLike)await this.likePublished(awaitingLike.id);
      this.checkExistingReplies();
      this.applyReplyPolicy();
      await this.loadPost();
      const s=this.store.settings();
      if(!this.chatgpt.status().enabled) return;
      const next=this.store.queued();
      // A comment that cannot be drafted (for example from another Page) must not block the comments behind it.
      if(next) try {await this.generate(next.id);} catch(error) {if(this.store.get(next.id)?.status==='queued')this.store.update(next.id,{status:'error',error:error.message});}
      const settings=this.store.settings();
      if(settings.mode==='approval') return;
      const draft=this.store.nextPublish(settings.mode);
      if(draft&&Date.now()-this.lastPublish>=settings.intervalSeconds*1000) {
        try {await this.publish(draft.id,undefined,true);} catch { /* state records failures; no immediate POST retry */ }
      }
    } finally { this.busy=false; }
  }
}
