import { buildPrompt, parseDraft } from './prompt.js';

// Accepts "owner/space-name" or the Space's hf.space / huggingface.co URL and returns its API origin.
export function spaceUrl(space) {
  const value=String(space||'').trim().replace(/\/+$/,'');
  let m=value.match(/^https:\/\/([a-z0-9-]+)\.hf\.space$/i);
  if(m) return 'https://'+m[1].toLowerCase()+'.hf.space';
  m=value.match(/^(?:https:\/\/huggingface\.co\/spaces\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/);
  if(!m) throw new Error('Enter your Space as owner/space-name, for example jacob/socialite-replies.');
  return 'https://'+(m[1]+'-'+m[2]).toLowerCase().replace(/[._]/g,'-')+'.hf.space';
}

function friendly(text) {
  if(/quota|exceeded your gpu|gpu task aborted|zerogpu/i.test(text)) return 'Hugging Face ZeroGPU daily quota is used up. It resets 24 hours after your first use of the day.';
  if(/401|403|unauthori[sz]ed|forbidden|invalid.*token/i.test(text)) return 'Hugging Face rejected the token. Paste a valid access token in Connections.';
  return 'The Hugging Face Space could not write the draft: '+String(text).slice(0,200);
}

export class HuggingFace {
  constructor(store, vault, fetcher=(...args)=>fetch(...args)) { this.store=store; this.vault=vault; this.fetch=fetcher; }
  configured() { return !!(this.store.settings().hfSpace&&this.vault.get('hfToken')); }
  headers(extra={}) { return {Authorization:'Bearer '+this.vault.get('hfToken'),...extra}; }
  async call(url, options, timeout) {
    try {return await this.fetch(url,{...options,signal:AbortSignal.timeout(timeout)});}
    catch(error) {
      console.error('Hugging Face request failed',url,error?.name,error?.message);
      if(error.name==='TimeoutError') throw new Error('The Hugging Face Space took too long. It may be waking up; try again in a few minutes.');
      throw new Error('Cannot reach the Hugging Face Space. Check your internet connection.');
    }
  }
  async check() {
    if(!this.configured()) throw new Error('Add your Hugging Face Space and access token in Connections.');
    const response=await this.call(spaceUrl(this.store.settings().hfSpace)+'/gradio_api/info',{headers:this.headers()},120000);
    if(response.status===401||response.status===403) throw new Error(friendly('401'));
    if(!response.ok) throw new Error('The Space did not answer ('+response.status+'). It may still be building or asleep; open it on Hugging Face to check.');
    const info=await response.json().catch(()=>({}));
    if(!info.named_endpoints?.['/draft']) throw new Error('This Space has no /draft endpoint. Use the Socialite reply drafter Space.');
    return {ok:true};
  }
  async generate(settings, comment) {
    if(!this.configured()) throw new Error('Add your Hugging Face Space and access token in Connections.');
    const base=spaceUrl(settings.hfSpace);
    const {instructions,requestInput}=buildPrompt(settings,comment);
    const start=await this.call(base+'/gradio_api/call/draft',{method:'POST',headers:this.headers({'Content-Type':'application/json'}),body:JSON.stringify({data:[instructions+'\nReturn only the JSON object, with no text before or after it.',JSON.stringify(requestInput),400]})},120000);
    if(!start.ok) {
      if(start.status===404) throw new Error('Hugging Face Space not found, or it is still building. Check the Space name in Connections.');
      throw new Error(friendly(start.status+' '+await start.text().catch(()=>'')));
    }
    const {event_id:eventId}=await start.json();
    if(!eventId) throw new Error('The Hugging Face Space did not accept the request.');
    // A sleeping Space wakes and loads the model first, which can take a few minutes.
    const stream=await this.call(base+'/gradio_api/call/draft/'+eventId,{headers:this.headers()},10*60*1000);
    const text=await stream.text();
    let output=null, failure='';
    for(const block of text.replace(/\r\n/g,'\n').split('\n\n')) {
      const event=block.match(/^event:\s*(.+)$/m)?.[1]?.trim(), data=block.match(/^data:\s*(.*)$/m)?.[1];
      if(event==='complete') {try{output=JSON.parse(data)[0];}catch{}}
      if(event==='error') failure=data&&data!=='null'?data:'unknown error';
    }
    if(failure) throw new Error(friendly(failure));
    if(typeof output!=='string') throw new Error('The Hugging Face Space returned no draft. Please regenerate.');
    const json=output.replace(/<think>[\s\S]*?<\/think>/g,'').match(/\{[\s\S]*\}/)?.[0]||output;
    return parseDraft(json,comment);
  }
}
