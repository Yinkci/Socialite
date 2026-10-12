import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, Vault } from '../src/db.js';
import { Store } from '../src/store.js';
import { ReplyMemory } from '../src/memory.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../src/auth.js';
import { DashboardCache } from '../src/dashboard-cache.js';
import { ensureWorkAlarm } from '../src/alarm.js';

test('background watchdog repairs alarms stranded by an outage and preserves active alarms',async()=>{
  const now=1000000;let at=null,writes=0;
  const storage={getAlarm:async()=>at,setAlarm:async value=>{at=value;writes++;}};
  assert.equal(await ensureWorkAlarm(storage,now),now+15000);assert.equal(writes,1);
  await ensureWorkAlarm(storage,now);assert.equal(writes,1,'future alarm is preserved');
  at=now-60000;await ensureWorkAlarm(storage,now);assert.equal(writes,1,'recent/running alarm is preserved');
  at=now-3600000;assert.equal(await ensureWorkAlarm(storage,now),now+15000);assert.equal(writes,2,'stranded alarm gets a fresh schedule');
});

test('dashboard snapshots are shared across tabs, refreshed on change and retried after failure',async()=>{
  const cache=new DashboardCache();let loads=0;
  const load=async()=>({total:++loads});
  const [a,b]=await Promise.all([cache.read('revision1-minute1',load),cache.read('revision1-minute1',load)]);
  assert.equal(loads,1);assert.equal(a,b);
  await cache.read('revision1-minute1',load);assert.equal(loads,1);
  assert.equal((await cache.read('revision2-minute1',load)).total,2);
  assert.equal((await cache.read('revision2-minute2',load)).total,3,'rolling statistics expire each minute');
  await assert.rejects(cache.read('failed',async()=>{throw Error('temporary failure');}));
  assert.equal((await cache.read('failed',load)).total,4,'failed snapshots never stick');
});

test('SQL revision tracks real changes and cached settings do not survive writes',()=>{
  const sql=fakeSql();let reads=0;
  const db=new DurableDatabase({exec(query,...args){if(query==='SELECT value FROM settings WHERE id=1')reads++;return sql.exec(query,...args);}});
  const store=new Store(db),revision=db.revision;
  store.settings();const firstReads=reads;store.settings();assert.equal(reads,firstReads,'repeated settings reads use memory');
  store.saveSettings({...store.settings(),pageId:'456'});
  assert.ok(db.revision>revision);assert.equal(store.settings().pageId,'456');assert.equal(reads,firstReads+1);
  const before=db.revision;db.prepare('UPDATE comments SET status=? WHERE id=?').run('pending','missing');assert.equal(db.revision,before,'no-op writes do not invalidate dashboard');
  db.exec("INSERT INTO activity(at,message) VALUES(0,'imported')");assert.ok(db.revision>before,'bulk imports invalidate dashboard');
});

// Mimics ctx.storage.sql: exec(query,...bindings) returns a cursor with toArray()/one().
function fakeSql() {
  const db=new DatabaseSync(':memory:');
  return {exec(query,...args){
    const rows=args.length||/^\s*(select|pragma)/i.test(query)&&!query.includes(';')?db.prepare(query).all(...args):(db.exec(query),[]);
    return {toArray:()=>rows,one:()=>{if(rows.length!==1)throw new Error('expected one row');return rows[0];}};
  }};
}

test('Store and reply memory run on the Durable Object SQL adapter',()=>{
  const store=new Store(new DurableDatabase(fakeSql()));
  store.saveSettings({...store.settings(),pageId:'123'});
  assert.equal(store.add({id:'c1',post_id:'123_1',message:'Lovely',source:'facebook'}),true);
  assert.equal(store.add({id:'c1',post_id:'123_1',message:'Lovely',source:'facebook'}),false,'duplicate webhook ignored');
  assert.equal(store.claim('c1','queued','generating'),true);
  assert.equal(store.claim('c1','queued','generating'),false,'claim reports real change counts');
  assert.equal(store.get('c1').page_id,'123');
  const memory=new ReplyMemory(store);
  assert.equal(memory.status().total,0);
});

test('vault keeps secrets in Durable Object key-value storage',()=>{
  const map=new Map(), vault=new Vault({get:k=>map.get(k),put:(k,v)=>map.set(k,v),delete:k=>map.delete(k)});
  vault.set('hfToken','hf_abc');assert.equal(vault.get('hfToken'),'hf_abc');assert.equal(map.get('vault:hfToken'),'hf_abc');
  vault.set('hfToken','');assert.equal(vault.get('hfToken'),undefined);
});

test('passwords are stored as salted PBKDF2 hashes',async()=>{
  const stored=await hashPassword('correct horse battery');
  assert.match(stored,/^pbkdf2\$100000\$/);assert.ok(!stored.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery',stored),true);
  assert.equal(await verifyPassword('wrong password',stored),false);
  assert.notEqual(await hashPassword('correct horse battery'),stored,'random salt');
  assert.equal(randomToken(32).length,43);assert.equal(sha256('a').length,64);
});
