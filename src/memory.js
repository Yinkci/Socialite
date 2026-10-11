const words=text=>String(text||'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const stop=new Set('a an the and or but to of for in on with is are was were it this that you your i my me we our us be have has so very do does'.split(' '));
const terms=text=>new Set(words(text).filter(w=>w.length>2&&!stop.has(w)));
const weight={edited:4,approved:2,historical:1,automatic:0.35};
const groups=[/\b(grief|loss|lost|died|death|son|daughter|mother|father|miss|heartbroken)\b/i,/\b(thank|thanks|bless|amen|love|beautiful|support)\b/i,/\b(hope|strong|strength|keep|going|give up|better|days|encourage)\b/i,/\b(refund|price|cost|order|shipping|delivery|buy)\b/i];

export class ReplyMemory {
  constructor(store){
    this.store=store;this.cache=null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS reply_memory (
      comment_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,comment TEXT NOT NULL,post TEXT NOT NULL,
      reply TEXT NOT NULL,kind TEXT NOT NULL,published_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_excluded (comment_id TEXT PRIMARY KEY,page_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    // Historical rows are used only when their Page identity was explicitly recorded.
    if(!store.db.prepare("SELECT 1 FROM memory_meta WHERE key='seeded'").get()){
      if(store.settings().learningEnabled){
      for(const c of store.db.prepare("SELECT * FROM comments WHERE source='facebook' AND status='published' AND page_id<>'' AND draft<>''").all())this.capture(c,c.publish_kind||'historical',c.page_id);
      }
      store.db.prepare("INSERT INTO memory_meta VALUES('seeded','1')").run();
    }
  }
  capture(c,kind='historical',pageId=c.page_id){
    if(!this.store.settings().learningEnabled||c.source!=='facebook'||c.status!=='published'||!pageId||!c.draft?.trim())return;
    if(this.store.db.prepare('SELECT 1 FROM memory_excluded WHERE comment_id=?').get(c.id))return;
    this.store.db.prepare('INSERT OR IGNORE INTO reply_memory VALUES(?,?,?,?,?,?,?)').run(c.id,pageId,c.message||'',c.context||'',c.draft,Object.hasOwn(weight,kind)?kind:'historical',c.updated_at||Date.now());
    this.cache=null;
  }
  remove(id){
    const pageId=this.store.settings().pageId;
    const row=this.store.db.prepare('SELECT comment_id FROM reply_memory WHERE comment_id=? AND page_id=?').get(id,pageId);
    if(!row)throw new Error('Reply memory example not found for this Page.');
    this.store.db.prepare('INSERT OR IGNORE INTO memory_excluded VALUES(?,?)').run(id,pageId);
    this.store.db.prepare('DELETE FROM reply_memory WHERE comment_id=? AND page_id=?').run(id,pageId);this.cache=null;
  }
  clear(){
    const pageId=this.store.settings().pageId;
    this.store.db.prepare('INSERT OR IGNORE INTO memory_excluded SELECT comment_id,page_id FROM reply_memory WHERE page_id=?').run(pageId);
    this.store.db.prepare('DELETE FROM reply_memory WHERE page_id=?').run(pageId);this.cache=null;
  }
  history(){
    const pageId=this.store.settings().pageId;
    if(this.cache?.pageId===pageId)return this.cache;
    const rows=this.store.db.prepare('SELECT * FROM reply_memory WHERE page_id=? ORDER BY published_at DESC,comment_id').all(pageId);
    const ownerWeight=rows.filter(r=>r.kind==='edited'||r.kind==='approved').reduce((n,r)=>n+weight[r.kind],0);
    const automaticWeight=rows.filter(r=>r.kind==='automatic').length*weight.automatic;
    // Many automatic replies must not drown out the owner's own choices.
    const automaticScale=ownerWeight&&automaticWeight?Math.min(1,ownerWeight*0.25/automaticWeight):1;
    const openings=new Map(),frequencies=new Map();let totalWeight=0,length=0,emojis=0,questions=0,exclamations=0;
    for(const r of rows){
      const w=(weight[r.kind]||1)*(r.kind==='automatic'?automaticScale:1);totalWeight+=w;length+=Array.from(r.reply).length*w;
      emojis+=(/\p{Extended_Pictographic}/u.test(r.reply)?1:0)*w;questions+=(r.reply.includes('?')?1:0)*w;exclamations+=(r.reply.includes('!')?1:0)*w;
      const opening=words(r.reply).slice(0,3).join(' ');if(opening)openings.set(opening,(openings.get(opening)||0)+w);
      r.tokens=terms(r.comment+' '+r.post);for(const token of r.tokens)frequencies.set(token,(frequencies.get(token)||0)+1);
    }
    const percentage=n=>totalWeight?Math.round(100*n/totalWeight):0;
    const summary=rows.length?{
      examples:rows.length,weighted_average_characters:Math.round(length/totalWeight),
      replies_with_emoji_percent:percentage(emojis),replies_with_questions_percent:percentage(questions),
      replies_with_exclamations_percent:percentage(exclamations),
      common_openings:[...openings].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([phrase])=>phrase)
    }:null;
    this.cache={pageId,rows,summary,frequencies};return this.cache;
  }
  status(){
    const {rows,summary}=this.history();
    const counts=Object.fromEntries(Object.keys(weight).map(kind=>[kind,rows.filter(r=>r.kind===kind).length]));
    return {enabled:this.store.settings().learningEnabled,total:rows.length,counts,summary,revision:rows.length+':'+(rows[0]?.published_at||0)};
  }
  list(offset=0){
    if(!Number.isInteger(offset)||offset<0)throw new Error('Invalid memory page.');
    const {rows}=this.history();return {offset,total:rows.length,rows:rows.slice(offset,offset+20).map(({tokens,...r})=>r)};
  }
  forDraft(comment){
    if(!this.store.settings().learningEnabled)return null;
    const {rows,summary,frequencies}=this.history();if(!rows.length)return null;
    const query=comment.message+' '+comment.context,q=terms(query);
    const relevant=rows.filter(r=>r.comment_id!==comment.id).map(r=>{
      let similarity=0;for(const token of q)if(r.tokens.has(token)){
        const frequency=frequencies.get(token)||0;
        similarity+=Math.log(1+rows.length/(1+frequency));
      }
      const topic=groups.reduce((n,pattern)=>n+Number(pattern.test(query)&&pattern.test(r.comment+' '+r.post)),0);
      return {r,score:similarity+topic*2+(weight[r.kind]||1)*0.35};
    }).sort((a,b)=>b.score-a.score||b.r.published_at-a.r.published_at);
    const seen=new Set(),examples=[];
    for(const {r} of relevant){
      const key=words(r.reply).join(' ');if(seen.has(key))continue;seen.add(key);
      examples.push({comment:r.comment.slice(0,1200),post:r.post.slice(0,1000),reply:r.reply.slice(0,1000),source:r.kind});
      if(examples.length===5)break;
    }
    return {style_summary:summary,examples};
  }
}
