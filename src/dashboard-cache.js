// Shared by all dashboard tabs on this app instance. Never caches authentication or CSRF tokens.
export class DashboardCache {
  constructor(){this.key=null;this.pending=null;}
  read(key,load){
    if(this.key!==key){
      this.key=key;
      const pending=Promise.resolve().then(load);
      this.pending=pending;
      pending.catch(()=>{if(this.pending===pending){this.key=null;this.pending=null;}});
    }
    return this.pending;
  }
}
