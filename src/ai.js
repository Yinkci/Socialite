export const AI_PROVIDERS=['chatgpt','huggingface','fallback'];

export class AIRouter {
  constructor(store,chatgpt,huggingface) {this.store=store;this.chatgpt=chatgpt;this.huggingface=huggingface;}
  status() {
    const provider=this.store.settings().aiProvider;
    const chatgpt=this.chatgpt.status().enabled,huggingface=this.huggingface.configured();
    return {provider,enabled:provider==='chatgpt'?chatgpt:provider==='huggingface'?huggingface:chatgpt||huggingface};
  }
  async generate(settings,comment) {
    if(settings.aiProvider==='chatgpt')return this.chatgpt.generate(settings,comment);
    if(settings.aiProvider==='huggingface')return this.huggingface.generate(settings,comment);
    if(this.chatgpt.status().enabled) {
      try{return await this.chatgpt.generate(settings,comment);}
      catch(error) {
        if(!this.huggingface.configured())throw error;
        this.store.log('ChatGPT could not write this draft ('+error.message+'). Using Hugging Face instead.');
      }
    }
    return this.huggingface.generate(settings,comment);
  }
}
