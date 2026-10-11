import { buildPrompt, parseDraft } from './prompt.js';

const RESOURCE='https://api.openai.com/v1';
const TOKEN_URL='https://auth.openai.com/api/accounts/oauth/token';
const PLAN_SCOPE='chatgpt.tokens.use.direct';

export async function readEvents(body,onEvent) {
  let buffer=''; const decoder=new TextDecoder();
  for await(const chunk of body) {
    buffer=(buffer+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');
    if(buffer.length>1024*1024) throw new Error('AI stream exceeded the response limit.');
    let end;
    while((end=buffer.indexOf('\n\n'))!==-1) {
      const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
      const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(data&&data!=='[DONE]')onEvent(JSON.parse(data));
    }
  }
}

export class ChatGPT {
  constructor(vault,fetcher=(...args)=>fetch(...args)) {this.vault=vault;this.fetch=fetcher;this.modelsCache=null;this.refreshing=null;}
  status() {
    const saved=this.vault.get('chatgpt')||{};
    return {enabled:!!(saved.client_id&&saved.access_token&&saved.refresh_token&&saved.scopes?.includes(PLAN_SCOPE)),email:saved.email||''};
  }
  importSession(saved) {
    if(!saved||typeof saved!=='object'||!/^oaiapp_[A-Za-z0-9_-]+$/.test(saved.client_id||'')||
      !saved.scopes?.includes(PLAN_SCOPE)||!saved.subject||!saved.access_token||!saved.refresh_token||
      !Number.isFinite(saved.expires_at)) throw new Error('Local ChatGPT plan session is incomplete. Sign in again on the local app.');
    this.vault.set('chatgpt',{client_id:saved.client_id,subject:saved.subject,email:typeof saved.email==='string'?saved.email:'',
      access_token:saved.access_token,refresh_token:saved.refresh_token,scopes:saved.scopes,expires_at:saved.expires_at});
    this.modelsCache=null;
  }
  disconnect() {this.vault.set('chatgpt',null);this.modelsCache=null;}
  async access() {
    let saved=this.vault.get('chatgpt');
    if(!this.status().enabled)throw new Error('ChatGPT session is not connected.');
    if(saved.expires_at<Date.now()+60000) {
      if(!this.refreshing)this.refreshing=(async()=>{
        const response=await this.fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({grant_type:'refresh_token',client_id:saved.client_id,refresh_token:saved.refresh_token,resource:RESOURCE}),signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error('Copied ChatGPT session could not refresh. Reconnect from the local app.');
        const result=await response.json();
        const next={...saved,...result,scopes:result.scope?result.scope.split(' '):saved.scopes,expires_at:Date.now()+Number(result.expires_in||3600)*1000};
        if(!next.scopes.includes(PLAN_SCOPE)||!next.access_token||!next.refresh_token)throw new Error('ChatGPT plan usage is no longer authorized.');
        this.vault.set('chatgpt',next);return next;
      })().finally(()=>{this.refreshing=null;});
      saved=await this.refreshing;
    }
    return saved.access_token;
  }
  async models() {
    const response=await this.fetch(RESOURCE+'/models',{headers:{Authorization:'Bearer '+await this.access()},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('Cannot load ChatGPT models. Check plan access or reconnect.');
    const result=await response.json();
    this.modelsCache=(result.models||[]).filter(m=>m.visibility==='list').map(m=>({id:m.slug,name:m.display_name||m.slug}));
    return this.modelsCache;
  }
  async generate(settings,comment) {
    const models=this.modelsCache||await this.models();
    const model=models.some(m=>m.id===settings.model)?settings.model:models[0]?.id;
    if(!model)throw new Error('No ChatGPT models are available for this plan.');
    const {instructions,requestInput}=buildPrompt(settings,comment);
    const response=await this.fetch(RESOURCE+'/responses',{method:'POST',headers:{Authorization:'Bearer '+await this.access(),'Content-Type':'application/json'},
      body:JSON.stringify({model,instructions,input:[{role:'user',content:JSON.stringify(requestInput)}],store:false,stream:true}),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(response.status===429?'ChatGPT plan usage limit reached.':'ChatGPT request failed. Check plan access or reconnect.');
    let output='',completed=false;
    await readEvents(response.body,event=>{
      if(event.type==='response.output_text.delta'){output+=event.delta;if(output.length>64000)throw new Error('AI output exceeded the reply limit.');}
      if(['response.failed','response.incomplete','error'].includes(event.type))throw new Error('ChatGPT did not finish the reply. Check plan limits or reconnect.');
      if(event.type==='response.completed')completed=true;
    });
    if(!completed)throw new Error('ChatGPT stream interrupted.');
    return parseDraft(output,comment);
  }
}
