export class Reactions {
  constructor(store,facebook){this.store=store;this.facebook=facebook;this.busy=new Set();}
  comment(id){const c=this.store.get(id);if(!c||c.cleared_at)throw new Error('Comment not found');if(c.status==='removed')throw new Error('This comment was removed.');if(c.source==='facebook'&&c.page_id&&c.page_id!==this.store.settings().pageId)throw new Error('This comment belongs to a different Page. Reconnect its original Page first.');return c;}
  async afterPublication(id){
    const c=this.comment(id);
    if(c.cleared_at||!['published','simulated'].includes(c.status))throw new Error('Like is applied only after a confirmed reply publication.');
    this.store.update(id,{reaction_choice:'LIKE',reaction_selected:1});
    await this.applyLike(id);
  }
  async applyLike(id){
    const c=this.comment(id);
    if(!['published','simulated'].includes(c.status))throw new Error('Publish the reply before applying its Like.');
    if(c.reaction_choice!=='LIKE')throw new Error('Only Like can be applied through the Facebook API. Heart and Care must be applied on Facebook.');
    if(this.busy.has(id)||c.reaction_status==='applying')throw new Error('A reaction is already being applied.');
    if(c.reaction_status==='uncertain')throw new Error('Check the Like directly on Facebook; it will not be retried automatically.');
    if(c.reaction_applied==='LIKE'&&['applied','simulated'].includes(c.reaction_status))return;
    this.busy.add(id);let sent=false;
    try{
      if(c.source==='test'){this.store.update(id,{reaction_status:'simulated',reaction_applied:'LIKE',reaction_error:''});return;}
      await this.facebook.verify();await this.facebook.current(c);
      this.store.update(id,{reaction_status:'applying',reaction_error:''});sent=true;
      await this.facebook.like(c);
      this.store.update(id,{reaction_status:'applied',reaction_applied:'LIKE',reaction_error:''});
      this.store.log(`Like applied to ${c.author}'s comment.`);
    }catch(error){this.store.update(id,{reaction_status:sent&&!error.definite?'uncertain':'error',reaction_error:error.message});throw error;}
    finally{this.busy.delete(id);}
  }
}
