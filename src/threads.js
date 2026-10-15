export const objectId=id=>String(id||'').split('_').pop();
export function historyOf(comment){try{const rows=JSON.parse(comment.thread_history||'[]');return Array.isArray(rows)?rows.slice(-40):[];}catch{return [];}}
export async function resolveThread(facebook,parentId,postId,childId){
  const store=facebook.store,pageId=store.settings().pageId,seen=new Set(),ancestors=[];
  let next=parentId,root='',pageSeen=false;
  for(let depth=0;next&&objectId(next)!==objectId(postId);depth++){
    if(depth>=8||seen.has(objectId(next)))throw Error('Conversation thread could not be resolved. Review it on Facebook.');
    seen.add(objectId(next));
    const known=store.threadRecord(next,postId);
    if(known){
      ancestors.push(...historyOf(known),{id:known.id,author:known.author,message:known.message,isPage:false,at:known.created_at});
      if(known.reply_id&&known.status==='published')ancestors.push({id:known.reply_id,author:'Your Page',message:known.draft,isPage:true,at:known.published_at||known.updated_at});
      root=known.thread_root||known.id;break;
    }
    const current=await facebook.request(next,'GET',{fields:'id,message,from,parent,created_time'});
    ancestors.unshift({id:current.id,author:current.from?.name||'Facebook user',message:current.message||'',isPage:current.from?.id===pageId,at:Date.parse(current.created_time)||0});
    root=current.id;next=current.parent?.id;
  }
  if(!root)throw Error('Conversation thread could not be resolved.');
  // Facebook may flatten replies beneath the original comment. This also finds Page replies written directly on Facebook.
  const replies=await facebook.commentReplies(root);
  const child=replies.find(r=>objectId(r.id)===objectId(childId)),cutoff=child?Date.parse(child.created_time)||Infinity:Infinity;
  const messages=[...ancestors,...replies.filter(r=>objectId(r.id)!==objectId(childId)&&(Date.parse(r.created_time)||0)<=cutoff).map(r=>({id:r.id,author:r.from?.name||'Facebook user',message:r.message||'',isPage:r.from?.id===pageId,at:Date.parse(r.created_time)||0}))];
  const unique=new Map();
  for(const row of messages){
    const key=objectId(row.id),old=unique.get(key);
    const entry=old?.isPage?{...row,isPage:true,author:old.author}:row;
    if(entry.isPage)pageSeen=true;
    if(entry.message&&key!==objectId(childId))unique.set(key,entry);
  }
  const history=[...unique.values()].sort((a,b)=>a.at-b.at).slice(-40);
  return {eligible:pageSeen,thread_root:root,thread_history:JSON.stringify(history)};
}
