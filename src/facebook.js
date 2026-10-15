import { createHmac, timingSafeEqual } from 'node:crypto';
import { objectId, resolveThread } from './threads.js';
import { followerReadings } from './followers.js';

export function validSignature(raw, signature, secret) {
  if(!secret||typeof signature!=='string') return false;
  const expected='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  return expected.length===signature.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(signature));
}

export class Facebook {
  constructor(store,vault,fetcher=(...args)=>fetch(...args)) { this.store=store; this.vault=vault; this.fetch=fetcher; }
  configured() { const s=this.store.settings(); return !!(s.pageId&&s.graphVersion&&this.vault.get('facebookToken')); }
  async request(path,method='GET',data={}) {
    const s=this.store.settings(); const token=this.vault.get('facebookToken');
    if(!this.configured()) throw new Error('Configure your Facebook Page, Graph API version, and Page access token.');
    const url=new URL(`https://graph.facebook.com/${s.graphVersion}/${path}`);
    const options={method,headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)};
    if(method==='GET') Object.entries(data).forEach(([k,v])=>url.searchParams.set(k,v));
    else {options.headers['Content-Type']='application/x-www-form-urlencoded';options.body=new URLSearchParams(data);}
    const response=await this.fetch(url,options);
    const result=await response.json();
    if(!response.ok||result.error) {
      const error=new Error(`Facebook request failed (code ${result.error?.code||response.status}). Check Page permissions and token in Meta.`);
      error.definite=response.status>=400&&response.status<500; throw error;
    }
    return result;
  }
  async verify(includeFollowers=false) {
    const s=this.store.settings(), token=this.vault.get('facebookToken');
    const page=await this.request('me','GET',{fields:includeFollowers?'id,name,followers_count':'id,name'});
    if(page.id!==s.pageId) throw new Error('This token belongs to a different Page. Supply the selected Page’s access token.');
    if(this.store.settings().pageId!==s.pageId||this.vault.get('facebookToken')!==token)throw new Error('Facebook connection changed during verification. Please verify again.');
    const current=this.store.settings(), cached=current.facebookPage?.id===page.id?current.facebookPage:{};
    const at=Date.now(),stats=includeFollowers&&Number.isSafeInteger(page.followers_count)&&page.followers_count>=0?{
      followersCount:page.followers_count,followersUpdatedAt:at,
      followersHistory:followerReadings([...(cached.followersHistory||[]),[cached.followersUpdatedAt,cached.followersCount],[at,page.followers_count]],at),
    }:{};
    if(typeof page.name==='string'&&page.name.trim())this.store.saveSettings({...current,facebookPage:{...cached,id:page.id,name:page.name,...stats}});
    return {id:page.id,name:page.name};
  }
  async subscribe() { await this.verify(); return this.request(this.store.settings().pageId+'/subscribed_apps','POST',{subscribed_fields:'feed'}); }
  async current(comment) {
    const data=await this.request(comment.id,'GET',{fields:'id,message,from,parent'});
    if(data.from?.id===this.store.settings().pageId) throw new Error('This comment belongs to your Page and will not be answered.');
    return data;
  }
  async context(comment) {
    const post=await this.request(comment.post_id,'GET',{fields:'message'});
    return post.message||'';
  }
  async post(postId) {
    const p=await this.request(postId,'GET',{fields:'message,permalink_url,full_picture'});
    const https=u=>typeof u==='string'&&u.startsWith('https://')?u:'';
    return {caption:p.message||'',url:https(p.permalink_url),image:https(p.full_picture)};
  }
  async publish(comment) { return this.request(comment.id+'/comments','POST',{message:comment.draft}); }
  async commentReplies(id){
    const rows=[];let after;
    for(let page=0;page<3;page++){
      const result=await this.request(id+'/comments','GET',{fields:'id,message,from,parent,created_time',limit:100,...(after?{after}:{})});
      rows.push(...(result.data||[]));
      if(!result.paging?.next)return rows;
      after=result.paging.cursors?.after;if(!after)break;
    }
    throw Error('This thread is too long to verify safely. Check it on Facebook before replying.');
  }
  async existingReply(comment){return (await this.commentReplies(comment.id)).find(r=>r.from?.id===this.store.settings().pageId);}
  async ingestWithThreads(payload){
    let count=this.ingest(payload);if(payload.object!=='page')return count;
    const settings=this.store.settings(),allowed=settings.postIds.split(/[\s,]+/).filter(Boolean);
    for(const entry of payload.entry||[])for(const change of entry.changes||[]){
      const v=change.value||{};
      if(String(entry.id)!==settings.pageId||change.field!=='feed'||v.item!=='comment'||v.verb!=='add'||!v.message||!v.comment_id||!v.post_id||!v.parent_id||objectId(v.parent_id)===objectId(v.post_id)||v.from?.id===settings.pageId||(allowed.length&&!allowed.includes(v.post_id)))continue;
      const known=this.store.threadRecord(v.comment_id,v.post_id);
      if(known)continue; // Includes our own recorded reply IDs and alternate ID formatting on retries.
      let thread;
      try{
        if(!v.from?.id){const current=await this.request(v.comment_id,'GET',{fields:'id,from'});if(current.from?.id===settings.pageId)continue;}
        thread=await resolveThread(this,v.parent_id,v.post_id,v.comment_id);if(!thread.eligible)continue;
      }catch(error){thread={status:'error',error:'Follow-up context could not be loaded. '+error.message};}
      const canonicalId=objectId(v.post_id)+'_'+objectId(v.comment_id);
      if(this.store.add({id:canonicalId,post_id:v.post_id,author:v.from?.name,author_id:v.from?.id,message:v.message,source:'facebook',parent_id:v.parent_id,is_followup:1,...thread}))count++;
    }
    return count;
  }
  async like(comment) {
    // Generic object /likes supports Page likes. Reactions /reactions is read-only.
    // A Like cannot replace an existing Heart/Care; never report that as a Like.
    try {
      const state=await this.request(comment.id+'/reactions','GET',{limit:0,summary:'viewer_reaction'});
      const existing=state.summary?.viewer_reaction;
      if(existing==='LIKE') return;
      if(existing!=='NONE') throw new Error(existing?'This comment already has a different Page reaction. Change it directly on Facebook.':'Facebook did not return your current reaction. Check it directly on Facebook.');
    } catch(error) {error.definite=true;throw error;}
    const result=await this.request(comment.id+'/likes','POST');
    if(result.success!==true) throw new Error('Facebook did not confirm that the Like was applied.');
  }
  // ---- Meta app webhook. A Meta app has one Page webhook address, so only one Socialite app receives comments.
  graph() { return `https://graph.facebook.com/${this.store.settings().graphVersion||'v24.0'}/`; }
  async metaApp() {
    const token=this.vault.get('facebookToken'), secret=this.vault.get('appSecret');
    if(!this.configured()||!secret) throw new Error('Save your Facebook Page, Page token and Meta app secret first.');
    const app=await (await this.fetch(this.graph()+'app?fields=id&access_token='+encodeURIComponent(token),{signal:AbortSignal.timeout(30000)})).json();
    if(!app.id) throw new Error('Facebook rejected the Page token: '+(app.error?.message||'unknown error'));
    return {id:app.id,token:app.id+'|'+secret};
  }
  // The address Meta currently sends Page comments to, or '' when none is set.
  async webhookTarget() {
    const app=await this.metaApp();
    const result=await (await this.fetch(`${this.graph()}${app.id}/subscriptions?access_token=${encodeURIComponent(app.token)}`,{signal:AbortSignal.timeout(30000)})).json();
    if(result.error) throw new Error('Could not read the Meta webhook: '+result.error.message);
    return (result.data||[]).find(s=>s.object==='page'&&s.active!==false)?.callback_url||'';
  }
  async connectWebhook(callback) {
    const app=await this.metaApp();
    const result=await (await this.fetch(this.graph()+app.id+'/subscriptions',{method:'POST',body:new URLSearchParams({object:'page',callback_url:callback,fields:'feed',include_values:'true',verify_token:this.vault.get('verifyToken'),access_token:app.token}),signal:AbortSignal.timeout(60000)})).json();
    if(!result.success) throw new Error('Meta did not accept the webhook: '+(result.error?.message||'unknown error'));
    await this.subscribe();
  }
  // Removes the Page webhook only when it still points at this app, so it never switches off the other app.
  async disconnectWebhook(isOwn) {
    const target=await this.webhookTarget();
    if(!target||!isOwn(target)) return false;
    const app=await this.metaApp();
    const result=await (await this.fetch(`${this.graph()}${app.id}/subscriptions?object=page&access_token=${encodeURIComponent(app.token)}`,{method:'DELETE',signal:AbortSignal.timeout(30000)})).json();
    if(!result.success) throw new Error('Meta did not remove the webhook: '+(result.error?.message||'unknown error'));
    return true;
  }
  ingest(payload) {
    if(payload.object!=='page') return 0;
    const s=this.store.settings();
    const allowed=s.postIds.split(/[\s,]+/).filter(Boolean); let count=0;
    for(const entry of payload.entry||[]) {
      if(String(entry.id)!==s.pageId) continue;
      for(const change of entry.changes||[]) {
        const v=change.value||{};
        if(change.field!=='feed'||v.item!=='comment'||!v.comment_id) continue;
        const existing=this.store.get(v.comment_id);
        if(existing?.cleared_at)continue;
        if(v.verb==='remove') {
          if(existing&&!['published','publishing','uncertain'].includes(existing.status)) this.store.update(v.comment_id,{status:'removed',draft:'',error:''});
          continue;
        }
        if(v.verb==='edited') {
          if(existing&&!['published','publishing','uncertain'].includes(existing.status)) this.store.update(v.comment_id,{message:v.message||'',status:existing.status==='rejected'?'rejected':'queued',draft:'',error:'',attempts:0,next_at:0});
          continue;
        }
        if(v.verb!=='add'||!v.message||v.from?.id===s.pageId||!v.post_id) continue;
        // Top-level comments are ingested synchronously. Nested replies are verified by ingestWithThreads.
        // Photo posts send parent_id as {other id}_{object id}, so compare only the object id after the last underscore.
        if(v.parent_id&&String(v.parent_id).split('_').pop()!==String(v.post_id).split('_').pop()) continue;
        if(allowed.length&&!allowed.includes(v.post_id)) continue;
        if(this.store.add({id:v.comment_id,post_id:v.post_id,author:v.from?.name,author_id:v.from?.id,message:v.message,source:'facebook',post_url:String(v.post?.permalink_url||'').startsWith('https://')?v.post.permalink_url:''})) count++;
      }
    }
    return count;
  }
}
