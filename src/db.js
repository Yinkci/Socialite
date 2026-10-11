// Makes a Durable Object's SQLite storage look like node:sqlite's DatabaseSync,
// so Store, ReplyMemory and the workflow run unchanged on Cloudflare.
export class DurableDatabase {
  constructor(sql) { this.sql=sql; }
  exec(query) { this.sql.exec(query).toArray(); }
  prepare(query) {
    const sql=this.sql;
    return {
      get: (...args)=>sql.exec(query,...args).toArray()[0],
      all: (...args)=>sql.exec(query,...args).toArray(),
      // rowsWritten also counts index writes, so ask SQLite for the real change count.
      run: (...args)=>{sql.exec(query,...args).toArray();return {changes:sql.exec('SELECT changes() AS n').one().n};},
    };
  }
}

// Secrets (Page token, App Secret, HF token, verify token) and login sessions.
// Durable Object storage is encrypted at rest by Cloudflare and is never sent to the dashboard.
export class Vault {
  constructor(kv) { this.kv=kv; }
  get(key) { return this.kv.get('vault:'+key); }
  set(key,value) { if(value===undefined||value===null||value==='')this.kv.delete('vault:'+key);else this.kv.put('vault:'+key,value); }
}
