import { withoutEmDashes } from './reply-text.js';

export const defaults = {
  personality: 'Warm, friendly, and concise. Match the commenter’s language. Use at most one emoji. Never invent facts, prices, promises, or personal experiences.',
  knowledge: '', examples: '', hfSpace: '', mode: 'approval', learningEnabled: true, replyPolicy: '', replyPolicyPageId: '', skipEmojiOnly: false,
  pageId: '', graphVersion: '', postIds: '', intervalSeconds: 30, commentDelaySeconds: 0, live: false,
};

export class Store {
  // db: anything with exec(sql) and prepare(sql).get/all/run. The Durable Object's SQLite in production, node:sqlite in tests.
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, post_id TEXT, author TEXT, message TEXT, context TEXT DEFAULT '',
        source TEXT NOT NULL, status TEXT DEFAULT 'queued', draft TEXT DEFAULT '',
        review INTEGER DEFAULT 1, reason TEXT DEFAULT '', error TEXT DEFAULT '',
        reply_id TEXT DEFAULT '', attempts INTEGER DEFAULT 0, next_at INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, at INTEGER, message TEXT);
    `);
    // Post preview columns, added after the first release.
    for(const col of ["post_url TEXT DEFAULT ''","post_image TEXT DEFAULT ''","post_loaded INTEGER DEFAULT 0","reaction_choice TEXT DEFAULT 'NONE'","reaction_selected INTEGER DEFAULT 0","reaction_status TEXT DEFAULT 'pending'","reaction_applied TEXT DEFAULT 'NONE'","reaction_error TEXT DEFAULT ''","manual_hold INTEGER DEFAULT 0","page_id TEXT DEFAULT ''","draft_history TEXT DEFAULT '[]'","publish_kind TEXT DEFAULT ''","published_at INTEGER DEFAULT 0","cleared_at INTEGER DEFAULT 0","like_after_publish INTEGER DEFAULT 0","reply_decision TEXT DEFAULT 'REVIEW'"]) {
      try { this.db.exec(`ALTER TABLE comments ADD COLUMN ${col}`); } catch { /* already exists */ }
    }
    for(const c of this.db.prepare("SELECT id,draft FROM comments WHERE status IN ('queued','pending','error','rejected') AND instr(draft,?)>0").all('\u2014')) {
      this.db.prepare('UPDATE comments SET draft=? WHERE id=?').run(withoutEmDashes(c.draft),c.id);
    }
    // Recover recorded send times only when published memory confirms the same method and reply.
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_memory'").get()) {
      this.db.exec(`UPDATE comments SET published_at=(SELECT published_at FROM reply_memory m WHERE m.comment_id=comments.id)
        WHERE status='published' AND published_at=0 AND publish_kind IN ('approved','edited','automatic')
        AND EXISTS (SELECT 1 FROM reply_memory m WHERE m.comment_id=comments.id AND m.kind=comments.publish_kind AND m.reply=comments.draft)`);
    }
    this.db.prepare("UPDATE comments SET reaction_status='uncertain', reaction_error='App stopped while applying a Like. Check Facebook before retrying.' WHERE reaction_status='applying'").run();
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (1,?)').run(JSON.stringify(defaults));
    this.saveSettings(this.settings()); // Remove the retired pause flag from saved preferences.
    this.db.prepare("UPDATE comments SET status='queued' WHERE status='generating'").run();
    this.db.prepare("UPDATE comments SET status='uncertain', error='App stopped while publishing. Check Facebook before retrying.' WHERE status='publishing'").run();
  }
  settings() { const {paused,...saved}=JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value);return { ...defaults, ...saved }; }
  saveSettings(s) { const {paused,...preferences}=s;this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(preferences)); }
  list() { return this.db.prepare('SELECT * FROM comments WHERE cleared_at=0 ORDER BY created_at DESC LIMIT 300').all(); }
  tabCounts() {
    const counts={all:0,new:0,pending:0,published:0,approved:0,automatic:0,error:0,rejected:0,skipped:0};
    for(const r of this.db.prepare("SELECT status,publish_kind,reaction_status,COUNT(*) AS n FROM comments WHERE cleared_at=0 AND status<>'removed' GROUP BY status,publish_kind,reaction_status").all()) {
      if(!['published','rejected','skipped'].includes(r.status))counts.all+=r.n;
      if(['queued','generating','pending','publishing'].includes(r.status))counts.new+=r.n;
      if(['pending','published','rejected','skipped'].includes(r.status))counts[r.status]+=r.n;
      if(r.status==='published') {
        if(['approved','edited'].includes(r.publish_kind))counts.approved+=r.n;
        if(r.publish_kind==='automatic')counts.automatic+=r.n;
      }
      if(!['published','skipped'].includes(r.status)&&(['error','uncertain'].includes(r.status)||['error','uncertain'].includes(r.reaction_status)))counts.error+=r.n;
    }
    return counts;
  }
  clearableCounts() {
    const counts={skipped:0,rejected:0};
    for(const r of this.db.prepare("SELECT status,COUNT(*) AS n FROM comments WHERE cleared_at=0 AND status IN ('skipped','rejected') AND (source='test' OR page_id='' OR page_id=?) GROUP BY status").all(this.settings().pageId))counts[r.status]=r.n;
    return counts;
  }
  clearHistory(status) {
    if(!['skipped','rejected'].includes(status))throw new Error('Only No reply needed or Dismissed replies can be cleared.');
    const pageId=this.settings().pageId;
    if(this.db.prepare("SELECT 1 FROM comments WHERE cleared_at=0 AND status=? AND (source='test' OR page_id='' OR page_id=?) AND reaction_status='applying' LIMIT 1").get(status,pageId))throw new Error('A reaction is being applied. Try clearing again after it finishes.');
    const count=this.db.prepare("UPDATE comments SET cleared_at=? WHERE cleared_at=0 AND status=? AND (source='test' OR page_id='' OR page_id=?)").run(Date.now(),status,pageId).changes;
    this.log(`${count} ${status==='skipped'?'no-reply':'dismissed'} conversations cleared from local history.`);
    return count;
  }
  get(id) { return this.db.prepare('SELECT * FROM comments WHERE id=?').get(id); }
  add(c) {
    const now = Date.now();
    const result = this.db.prepare('INSERT OR IGNORE INTO comments(id,post_id,author,message,context,source,post_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.post_id || '', c.author || 'Facebook user', c.message, c.context || '', c.source, c.post_url || '', now, now);
    if(result.changes===1&&c.source==='facebook')this.db.prepare('UPDATE comments SET page_id=? WHERE id=?').run(this.settings().pageId,c.id);
    return result.changes === 1;
  }
  update(id, fields) {
    const allowed = ['message','context','post_url','post_image','post_loaded','status','draft','review','reason','error','reply_id','attempts','next_at','reaction_choice','reaction_selected','reaction_status','reaction_applied','reaction_error','manual_hold','draft_history','publish_kind','published_at','like_after_publish','reply_decision'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;
    this.db.prepare(`UPDATE comments SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`)
      .run(...keys.map(k => fields[k]), Date.now(), id);
  }
  claim(id, from, to) {
    return this.db.prepare('UPDATE comments SET status=?, updated_at=? WHERE id=? AND status=?').run(to, Date.now(), id, from).changes === 1;
  }
  needsPost() { return this.db.prepare("SELECT * FROM comments WHERE source='facebook' AND cleared_at=0 AND post_loaded=0 AND post_id<>'' AND status NOT IN ('removed','rejected','skipped') ORDER BY created_at DESC LIMIT 1").get(); }
  queued() { return this.db.prepare("SELECT * FROM comments WHERE cleared_at=0 AND status='queued' AND next_at<=? ORDER BY created_at LIMIT 1").get(Date.now()); }
  nextPublish(mode) { return this.db.prepare("SELECT * FROM comments WHERE cleared_at=0 AND status='pending' AND source='facebook' AND error='' AND manual_hold=0 AND reply_decision='REPLY' AND created_at<=? AND (?='automatic' OR review=0) ORDER BY created_at LIMIT 1").get(Date.now()-this.settings().commentDelaySeconds*1000,mode); }
  lastPublished() { return this.db.prepare("SELECT MAX(updated_at) AS at FROM comments WHERE status='published'").get().at||0; }
  hasActiveFacebook() { return !!this.db.prepare("SELECT id FROM comments WHERE cleared_at=0 AND source='facebook' AND (status NOT IN ('published','removed','rejected','skipped') OR reaction_status IN ('applying','uncertain')) LIMIT 1").get(); }
  log(message) { this.db.prepare('INSERT INTO activity(at,message) VALUES(?,?)').run(Date.now(),message); }
  activity() { return this.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 30').all(); }
  close() { this.db.close?.(); }
}
