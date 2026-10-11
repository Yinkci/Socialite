// Socialite Cloud: Cloudflare Worker + one Durable Object that holds all app state.
// Ported from the local Automation app (src/server.js); the reply workflow, reply rules,
// Facebook client, reply memory and reactions are the same code.
import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { Store } from './store.js';
import { DurableDatabase, Vault } from './db.js';
import { HuggingFace, spaceUrl } from './hf.js';
import { Facebook, validSignature } from './facebook.js';
import { Workflow } from './workflow.js';
import { LiveSwitch } from './live.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from './auth.js';

const TICK_MS=15000, STATS_MS=5*60*1000, SESSION_MS=30*24*60*60*1000;
const SECURITY_HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};

function json(status,value,headers={}) {
  return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...SECURITY_HEADERS,...headers}});
}

export default {
  async fetch(request, env) {
    const path=new URL(request.url).pathname;
    // Everything except static dashboard files goes to the single app instance.
    if(path.startsWith('/api/')||path.startsWith('/webhooks/')||path.startsWith('/internal/')) return env.APP.get(env.APP.idFromName('main')).fetch(request);
    return env.ASSETS.fetch(request);
  },
  // Watchdog: makes sure the app's 15-second work loop is scheduled, even after a deploy.
  async scheduled(event, env) {
    await env.APP.get(env.APP.idFromName('main')).fetch('https://internal/internal/wake',{method:'POST'});
  },
};

export class SocialiteApp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store=new Store(new DurableDatabase(ctx.storage.sql));
    this.vault=new Vault(ctx.storage.kv);
    if(!this.vault.get('verifyToken')) this.vault.set('verifyToken',randomToken(24));
    this.huggingface=new HuggingFace(this.store,this.vault);
    // The workflow calls its AI "chatgpt"; here the only AI is the Hugging Face Space.
    const ai={status:()=>({enabled:this.huggingface.configured()}),generate:(settings,comment)=>this.huggingface.generate(settings,comment)};
    this.facebook=new Facebook(this.store,this.vault);
    this.workflow=new Workflow(this.store,ai,this.facebook);
    this.live=new LiveSwitch(this.store,this.facebook,{ownUrl:async()=>this.webhookUrl(),isOwn:url=>url===this.webhookUrl()});
  }
  webhookUrl() { return this.env.PUBLIC_URL?this.env.PUBLIC_URL.replace(/\/+$/,'')+'/webhooks/facebook':''; }

  async ensureAlarm() { if(await this.ctx.storage.getAlarm()===null) await this.ctx.storage.setAlarm(Date.now()+TICK_MS); }

  async alarm() {
    try {
      await this.workflow.tick();
      // Every minute: see where Meta sends comments; switch off if the local app went live.
      // Live Off: no background Facebook calls at all (followers, webhook checks).
      if(this.live.on()) {
        if(Date.now()-(this.ctx.storage.kv.get('liveCheckAt')||0)>60000) {this.ctx.storage.kv.put('liveCheckAt',Date.now());await this.live.check();}
        const last=this.ctx.storage.kv.get('statsAt')||0;
        if(this.facebook.configured()&&Date.now()-last>STATS_MS) {this.ctx.storage.kv.put('statsAt',Date.now());await this.facebook.verify(true).catch(()=>{});}
      }
    } catch(error) { console.error('tick failed',error?.stack||error); this.store.log('Worker stopped this pass; check comment errors.'); }
    finally { await this.ctx.storage.setAlarm(Date.now()+TICK_MS); }
  }

  async fetch(request) {
    const url=new URL(request.url), path=url.pathname;
    try {
      // Read the body once, before any early answer: an unread body breaks the connection for the next request.
      const body=request.method==='POST'?Buffer.from(await request.arrayBuffer()):Buffer.alloc(0);
      if(body.length>1024*1024) return json(413,{error:'Request too large'});
      const input=()=>{try{return JSON.parse(body.toString()||'{}');}catch{return {};}};
      if(path==='/internal/wake') {await this.ensureAlarm();return json(200,{ok:true});}
      if(path==='/internal/import') return await this.importData(request,input());
      if(path==='/webhooks/facebook') return await this.webhook(request,url,body);
      await this.ensureAlarm();
      if(path==='/api/auth-status'&&request.method==='GET') return json(200,{setup:!this.vault.get('passwordHash'),signedIn:!!this.session(request)});
      if(path==='/api/login'&&request.method==='POST') return await this.login(request,url,input());
      if(path==='/api/logout'&&request.method==='POST') {
        const sid=this.cookie(request);if(sid)this.ctx.storage.kv.delete('session:'+sha256(sid));
        return json(200,{ok:true},{'Set-Cookie':'sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
      }
      const session=this.session(request);
      if(!session) return json(401,{error:'Please sign in.'});
      if(request.method==='GET'&&path==='/api/state') return json(200,await this.state(session,url));
      if(request.method==='GET'&&path==='/api/memory') return json(200,this.workflow.memory.list(Number(url.searchParams.get('offset')||0)));
      if(request.method!=='POST') return json(404,{error:'Not found'});
      if(request.headers.get('origin')!==url.origin||request.headers.get('x-csrf-token')!==session.csrf||!request.headers.get('content-type')?.startsWith('application/json')) return json(403,{error:'Invalid request. Reload the page and try again.'});
      return json(200,await this.api(path,input(),url));
    } catch(error) { console.error('request failed',path,error?.stack||error); return json(400,{error:error.message||'Request failed.'}); }
  }

  // ---- Login: one owner password, stored as a PBKDF2 hash; sessions in a Secure HttpOnly cookie.
  cookie(request) { return (request.headers.get('cookie')||'').match(/(?:^|;\s*)sid=([A-Za-z0-9_-]{20,})/)?.[1]; }
  session(request) {
    const sid=this.cookie(request);if(!sid)return null;
    const s=this.ctx.storage.kv.get('session:'+sha256(sid));
    if(!s||s.expires<Date.now())return null;
    return s;
  }
  async login(request,url,input) {
    if(request.headers.get('origin')!==url.origin) return json(403,{error:'Invalid request.'});
    const lock=this.ctx.storage.kv.get('loginLock')||{fails:0,until:0};
    if(lock.until>Date.now()) return json(429,{error:'Too many attempts. Try again in 15 minutes.'});
    const password=typeof input.password==='string'?input.password:'';
    if(!this.vault.get('passwordHash')) {
      // First run: the setup code (a Worker secret given to the owner) proves this is the owner.
      if(!this.env.SETUP_CODE||input.setupCode!==this.env.SETUP_CODE) return this.loginFailed(lock,'The setup code is not correct.');
      if(password.length<10) return json(400,{error:'Choose a password with at least 10 characters.'});
      this.vault.set('passwordHash',await hashPassword(password));
      this.store.log('Dashboard password created.');
    } else if(!await verifyPassword(password,this.vault.get('passwordHash'))) return this.loginFailed(lock,'Incorrect password.');
    this.ctx.storage.kv.delete('loginLock');
    const sid=randomToken(32);
    this.ctx.storage.kv.put('session:'+sha256(sid),{csrf:randomToken(32),expires:Date.now()+SESSION_MS});
    return json(200,{ok:true},{'Set-Cookie':`sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS/1000}`});
  }
  loginFailed(lock,message) {
    const fails=lock.fails+1;
    this.ctx.storage.kv.put('loginLock',{fails:fails>=10?0:fails,until:fails>=10?Date.now()+15*60*1000:0});
    return json(401,{error:message});
  }

  // ---- Meta webhook (same checks as the local app).
  async webhook(request,url,raw) {
    if(request.method==='GET') {
      const p=url.searchParams;
      if(p.get('hub.mode')==='subscribe'&&p.get('hub.verify_token')===this.vault.get('verifyToken')) return new Response(p.get('hub.challenge')||'',{headers:{'Content-Type':'text/plain'}});
      return json(403,{error:'Verification failed'});
    }
    if(request.method!=='POST') return json(405,{error:'Method not allowed'});
    if(!validSignature(raw,request.headers.get('x-hub-signature-256'),this.vault.get('appSecret'))) return json(403,{error:'Invalid signature'});
    if(!this.live.on()) return json(200,{received:false});
    const count=this.facebook.ingest(JSON.parse(raw.toString()));
    if(count) this.store.log(`Received ${count} new Facebook comment${count===1?'':'s'}.`);
    return json(200,{received:true});
  }

  async state(session,url) {
    const {store,vault,facebook,workflow}=this, s=store.settings(), page=facebook.configured()&&s.facebookPage?.id===s.pageId?s.facebookPage:null;
    return {app:'Socialite',csrf:session.csrf,settings:s,
      replyAI:{provider:'huggingface',enabled:this.huggingface.configured()},huggingface:{hasToken:!!vault.get('hfToken')},
      facebook:{configured:facebook.configured(),pageName:page?.name||'',followersCount:page?.followersCount??null,followersUpdatedAt:page?.followersUpdatedAt??null,hasAppSecret:!!vault.get('appSecret'),hasToken:!!vault.get('facebookToken'),verifyToken:vault.get('verifyToken')},
      memory:workflow.memory.status(),comments:store.list(),tabCounts:store.tabCounts(),clearableCounts:store.clearableCounts(),activity:store.activity(),
      webhookUrl:this.webhookUrl()||url.origin+'/webhooks/facebook',live:await this.live.state()};
  }

  validateSettings(input) {
    const {store}=this, previous=store.settings(), next={...previous};
    for(const key of ['personality','knowledge','examples','pageId','graphVersion','postIds','replyPolicy']) {
      if(key in input) {if(typeof input[key]!=='string'||input[key].length>20000) throw new Error('Invalid setting: '+key);next[key]=input[key];}
    }
    if('skipEmojiOnly' in input){if(typeof input.skipEmojiOnly!=='boolean')throw new Error('Invalid emoji-only preference');next.skipEmojiOnly=input.skipEmojiOnly;}
    if('replyPolicy' in input||'skipEmojiOnly' in input)next.replyPolicyPageId=next.pageId;
    if('learningEnabled' in input){if(typeof input.learningEnabled!=='boolean')throw new Error('Invalid learning preference');next.learningEnabled=input.learningEnabled;}
    if('hfSpace' in input){
      if(typeof input.hfSpace!=='string'||input.hfSpace.length>300)throw new Error('Invalid Hugging Face Space');
      const space=input.hfSpace.trim();if(space)spaceUrl(space);next.hfSpace=space;
    }
    if('mode' in input) {if(!['approval','hybrid','automatic'].includes(input.mode)) throw new Error('Invalid mode');next.mode=input.mode;}
    if('intervalSeconds' in input) {const n=Number(input.intervalSeconds);if(!Number.isInteger(n)||n<10||n>3600) throw new Error('Reply spacing must be 10–3600 seconds.');next.intervalSeconds=n;}
    if('commentDelaySeconds' in input) {const n=Number(input.commentDelaySeconds);if(input.commentDelaySeconds===null||input.commentDelaySeconds===''||!Number.isInteger(n)||n<0||n>3600)throw new Error('Minimum comment delay must be 0-3600 seconds.');next.commentDelaySeconds=n;}
    if(next.pageId&&!/^\d+$/.test(next.pageId)) throw new Error('Page ID must contain only digits.');
    if(next.graphVersion&&!/^v\d+\.0$/.test(next.graphVersion)) throw new Error('Use the Graph API version shown in your Meta app, such as v24.0.');
    if(previous.pageId&&previous.pageId!==next.pageId&&store.hasActiveFacebook()) throw new Error('Resolve queued Facebook comments before switching Pages.');
    return next;
  }

  async api(path,input,url) {
    const {store,vault,facebook,workflow,huggingface}=this;
    if(path==='/api/settings') {
      if(typeof input.hfToken==='string'&&input.hfToken.trim()){const token=input.hfToken.trim();if(!token.startsWith('hf_')||token.length<20||token.length>200||/[^A-Za-z0-9_]/.test(token))throw new Error('Paste a Hugging Face access token. It starts with hf_.');vault.set('hfToken',token);}
      store.saveSettings(this.validateSettings(input));return {ok:true};
    }
    if(path==='/api/huggingface/check') return await huggingface.check();
    if(path==='/api/password') {
      if(!await verifyPassword(String(input.current||''),vault.get('passwordHash')))throw new Error('Your current password is not correct.');
      if(typeof input.password!=='string'||input.password.length<10)throw new Error('Choose a new password with at least 10 characters.');
      vault.set('passwordHash',await hashPassword(input.password));
      for(const [key] of [...this.ctx.storage.kv.list({prefix:'session:'})])this.ctx.storage.kv.delete(key);
      store.log('Dashboard password changed. All devices were signed out.');return {ok:true,signedOut:true};
    }
    if(path==='/api/facebook/save') {
      const next=this.validateSettings(input);
      for(const [field,key] of [['pageToken','facebookToken'],['appSecret','appSecret']]) {
        if(input[field]) {if(typeof input[field]!=='string'||input[field].length>5000) throw new Error('Invalid credential');vault.set(key,input[field].trim());}
      }
      store.saveSettings({...next,...(input.pageToken||next.pageId!==store.settings().pageId?{facebookPage:null}:{})});
      if(this.live.on()&&facebook.configured())await facebook.verify(true).catch(()=>{});
      return {ok:true};
    }
    if(path==='/api/facebook/verify') return await facebook.verify(true);
    if(path==='/api/facebook/subscribe') return await facebook.subscribe();
    if(path==='/api/live') {if(typeof input.on!=='boolean')throw new Error('Invalid Live setting');if(input.on)await this.live.turnOn();else await this.live.turnOff();return {ok:true,live:await this.live.state()};}
    if(path==='/api/test-comment') {
      if(typeof input.message!=='string'||!input.message.trim()||input.message.length>10000||typeof input.context!=='string'||input.context.length>20000) throw new Error('Enter a valid test comment and post context.');
      const id='test-'+crypto.randomUUID();store.add({id,author:'Test commenter',message:input.message,context:input.context,source:'test'});return {id};
    }
    if(path==='/api/memory/delete'){workflow.memory.remove(input.id);return {ok:true};}
    if(path==='/api/memory/clear'){workflow.memory.clear();return {ok:true};}
    if(path==='/api/comments/clear'){const cleared=store.clearHistory(input.status);return {ok:true,cleared};}
    // Live Off: nothing touches Facebook or the AI.
    if(['/api/draft','/api/approve','/api/resolve-uncertain'].includes(path))this.live.require();
    const c=store.get(input.id);
    if(!c||c.cleared_at) throw new Error('Comment not found');
    if(path==='/api/draft') {if(!['queued','pending','error','rejected','skipped'].includes(c.status)) throw new Error('This comment cannot be drafted.');const result=await workflow.generate(c.id,input.draft,input.instructions,input.editingMode);if(result?.ok===false)throw new Error(result.error);return {ok:true,...result};}
    if(path==='/api/approve') {await workflow.publish(c.id,input.draft);return {ok:true};}
    if(path==='/api/reject') {if(!['queued','pending','error'].includes(c.status)) throw new Error('This reply cannot be dismissed.');store.update(c.id,{status:'rejected',manual_hold:1,error:''});return {ok:true};}
    if(path==='/api/resolve-uncertain') {
      if(c.status!=='uncertain'||!['published','pending'].includes(input.status)) throw new Error('Invalid resolution');
      store.update(c.id,{status:input.status,error:'',...(input.status==='published'?{published_at:Date.now(),like_after_publish:1}:{})});if(input.status==='published')await workflow.likePublished(c.id);if(input.status==='published')workflow.memory.capture(store.get(c.id),c.publish_kind||'historical',c.page_id);store.log('Posting outcome manually checked for '+c.author);return {ok:true};
    }
    throw new Error('Not found');
  }

  // One-time copy of the local app's data. Enabled only while the IMPORT_TOKEN secret exists.
  async importData(request,data) {
    const expected=this.env.IMPORT_TOKEN;
    if(!expected||request.method!=='POST'||request.headers.get('authorization')!=='Bearer '+expected) return json(404,{error:'Not found'});
    const db=this.store.db;
    const columns=table=>db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
    const insert=(table,rows)=>{
      const known=columns(table);let n=0;
      for(const row of rows||[]){const keys=Object.keys(row).filter(k=>known.includes(k));if(!keys.length)continue;
        db.prepare(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));n++;}
      return n;
    };
    if(data.settings) this.store.saveSettings({...this.store.settings(),...data.settings});
    const counts={comments:insert('comments',data.comments),activity:insert('activity',data.activity),reply_memory:insert('reply_memory',data.reply_memory),memory_excluded:insert('memory_excluded',data.memory_excluded)};
    for(const key of ['facebookToken','appSecret','verifyToken','hfToken']) if(data.vault?.[key]) this.vault.set(key,data.vault[key]);
    this.workflow.memory.cache=null;
    this.store.log('Imported settings, history and reply memory from the local app.');
    return json(200,{ok:true,counts});
  }
}
