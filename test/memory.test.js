import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './helpers.js';
import { ReplyMemory } from '../src/memory.js';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'socialite-memory-')),store=openStore(dir);
  store.saveSettings({...store.settings(),pageId:'123'});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}
function published(store,id,extra={}){
  store.add({id,source:'facebook',message:'Thanks for your support',context:'Hope and encouragement',...extra});
  store.update(id,{status:'published',draft:'Thank you for being here!',...extra});return store.get(id);
}

test('initial memory imports confirmed, bound publications, not test, unbound, or pending drafts',t=>{
  const store=setup(t);published(store,'good');published(store,'unknown');
  store.db.prepare("UPDATE comments SET page_id='' WHERE id='unknown'").run();
  published(store,'test',{source:'test'});published(store,'pending',{status:'pending'});
  const memory=new ReplyMemory(store);assert.equal(memory.status().total,1);
  assert.equal(memory.list().rows[0].comment_id,'good');assert.equal(memory.list().rows[0].kind,'historical');
});

test('full history beyond the inbox limit shapes summary, with edited replies weighted more than automatic ones',t=>{
  const store=setup(t),memory=new ReplyMemory(store);
  for(let i=0;i<350;i++)memory.capture(published(store,'p'+i,{draft:i===349?'You have our heartfelt support.':'Thanks!'}),'approved');
  assert.equal(store.list().length,300);assert.equal(memory.status().total,350);assert.equal(memory.status().summary.examples,350);
  assert.equal(memory.list(340).rows.length,10);
  memory.clear();memory.capture(published(store,'edited',{draft:'Thank you!'}),'edited');
  memory.capture(published(store,'automatic',{draft:'x'.repeat(100)}),'automatic');
  assert.ok(memory.status().summary.weighted_average_characters<30);
  for(let i=0;i<30;i++)memory.capture(published(store,'auto'+i,{draft:'x'.repeat(100)}),'automatic');
  assert.ok(memory.status().summary.weighted_average_characters<30); // Automatic volume cannot overwhelm owner edits.
});

test('retrieval selects matching topics, deduplicates reply wording, and excludes the current comment',t=>{
  const store=setup(t),memory=new ReplyMemory(store);
  for(let i=0;i<8;i++)memory.capture(published(store,'routine'+i,{draft:i<3?'Thanks!':'Appreciate your support '+i}),'approved');
  memory.capture(published(store,'grief',{message:'I lost my son and miss him',context:'Loss and grief',draft:'I am so sorry for your loss. Sending you love.'}),'edited');
  const input={id:'new',message:'My son died. I miss him.',context:'Grief'};
  const selected=memory.forDraft(input);assert.equal(selected.examples.length,5);assert.match(selected.examples[0].reply,/sorry for your loss/);
  assert.equal(new Set(selected.examples.map(x=>x.reply)).size,selected.examples.length);assert.ok(selected.examples.filter(x=>x.reply==='Thanks!').length<=1);
  assert.equal(memory.forDraft({...input,id:'grief'}).examples.some(x=>x.reply.includes('sorry for your loss')),false);
});

test('learning off stops both saving and using memory, and does not retroactively import publications on restart',t=>{
  const store=setup(t),memory=new ReplyMemory(store);memory.capture(published(store,'first'),'approved');
  store.saveSettings({...store.settings(),learningEnabled:false});memory.capture(published(store,'off'),'edited');
  assert.equal(memory.status().total,1);assert.equal(memory.forDraft({message:'Thanks'}),null);
  store.saveSettings({...store.settings(),learningEnabled:true});
  assert.equal(new ReplyMemory(store).status().total,1);assert.ok(memory.forDraft({message:'Thanks'}));
});

test('forgotten examples remain deleted on restart, clearing only affects the selected Page',t=>{
  const store=setup(t),memory=new ReplyMemory(store);memory.capture(published(store,'one'),'edited');
  memory.remove('one');memory.capture(store.get('one'),'edited');assert.equal(memory.status().total,0);
  assert.equal(new ReplyMemory(store).status().total,0);assert.equal(store.get('one').status,'published');
  memory.capture(published(store,'two'),'approved');store.saveSettings({...store.settings(),pageId:'456'});
  memory.capture(published(store,'other'),'approved');assert.equal(memory.status().total,1);
  assert.throws(()=>memory.remove('two'),/this Page/);memory.clear();assert.equal(memory.status().total,0);
  store.saveSettings({...store.settings(),pageId:'123'});assert.equal(memory.status().total,1);
  assert.equal(memory.forDraft({message:'Thanks'}).examples[0].reply,'Thank you for being here!');
});
