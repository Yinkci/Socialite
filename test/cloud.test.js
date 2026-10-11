import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableDatabase, Vault } from '../src/db.js';
import { Store } from '../src/store.js';
import { ReplyMemory } from '../src/memory.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../src/auth.js';

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
