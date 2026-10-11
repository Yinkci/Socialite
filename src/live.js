// Live On/Off switch, shared by the local app and the Cloudflare app.
// On:  Facebook comments are sent to this app, and it drafts, publishes and likes.
// Off: this app does nothing with Facebook or the AI; settings and history stay viewable.
// Only one app can be live: Meta has one webhook address per Meta app, so when the other app
// switches on, this one notices on its next check and switches itself off.
export class LiveSwitch {
  // ownUrl(): this app's current webhook address ('' if unknown). isOwn(url): whether an address belongs to this app.
  constructor(store,facebook,{ownUrl,isOwn}) { this.store=store; this.facebook=facebook; this.ownUrl=ownUrl; this.isOwn=isOwn; this.status={checkedAt:0,target:'',error:''}; }
  on() { return !!this.store.settings().live; }
  set(live) { this.store.saveSettings({...this.store.settings(),live}); }
  require() { if(!this.on()) throw new Error('Socialite is Live Off. Turn Live On to draft, publish or like replies.'); }
  async turnOn() {
    const url=await this.ownUrl();
    if(!url) throw new Error('This app has no public webhook address yet. Start the tunnel (autostart.vbs) and try again.');
    await this.facebook.connectWebhook(url);
    this.set(true);this.status={checkedAt:Date.now(),target:url,error:''};
    this.store.log('Live On: Facebook comments now arrive at this app.');
  }
  async turnOff() {
    this.set(false);
    try {if(this.facebook.configured()&&await this.facebook.disconnectWebhook(url=>this.isOwn(url)))this.status={checkedAt:Date.now(),target:'',error:''};}
    catch(error) {this.store.log('Live Off, but the Facebook webhook could not be removed: '+error.message);}
    this.store.log('Live Off: drafting, publishing and Likes are stopped.');
  }
  // Runs about once a minute: records where Meta sends comments and steps aside if the other app took over.
  async check() {
    if(!this.facebook.configured()) return;
    try {
      const target=await this.facebook.webhookTarget();
      this.status={checkedAt:Date.now(),target,error:''};
      if(this.on()&&target&&!this.isOwn(target)) {this.set(false);this.store.log('Live Off: the other Socialite app is now live, so this one switched off.');}
    } catch(error) {this.status={...this.status,checkedAt:Date.now(),error:error.message};}
  }
  async state() {
    const own=await this.ownUrl();
    return {on:this.on(),receiving:!!this.status.target&&this.isOwn(this.status.target),target:this.status.target,checkedAt:this.status.checkedAt,error:this.status.error,ownUrl:own};
  }
}
