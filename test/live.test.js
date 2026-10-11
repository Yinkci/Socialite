import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { LiveSwitch } from '../src/live.js';

const MINE='https://mine.example/webhooks/facebook', OTHER='https://other.example/webhooks/facebook';
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'live-test-')), store=new Store(new DatabaseSync(join(dir,'studio.sqlite')));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const meta={target:'',calls:[]};
  const facebook={configured:()=>true,
    webhookTarget:async()=>meta.target,
    connectWebhook:async url=>{meta.calls.push('connect');meta.target=url;},
    disconnectWebhook:async isOwn=>{meta.calls.push('disconnect');if(meta.target&&isOwn(meta.target)){meta.target='';return true;}return false;}};
  const live=new LiveSwitch(store,facebook,{ownUrl:async()=>MINE,isOwn:url=>url===MINE});
  return {store,live,meta};
}

test('Live On points comments here; Live Off stops and removes only this app\'s webhook',async t=>{
  const {store,live,meta}=setup(t);
  await live.turnOn();
  assert.equal(store.settings().live,true);assert.equal(meta.target,MINE);
  assert.deepEqual(await live.state().then(s=>[s.on,s.receiving]),[true,true]);
  await live.turnOff();
  assert.equal(store.settings().live,false);assert.equal(meta.target,'');
  meta.target=OTHER;await live.turnOff();
  assert.equal(meta.target,OTHER,'never removes the other app\'s webhook');
});

test('switches itself off when the other app goes live',async t=>{
  const {store,live,meta}=setup(t);
  await live.turnOn();
  meta.target=OTHER;await live.check();
  assert.equal(store.settings().live,false);
  assert.match(store.activity()[0].message,/other Socialite app is now live/);
  const s=await live.state();assert.equal(s.receiving,false);assert.equal(s.target,OTHER);
});

test('Live Off blocks actions that touch Facebook or the AI',async t=>{
  const {store,live}=setup(t);
  store.saveSettings({...store.settings(),live:false});
  assert.throws(()=>live.require(),/Live Off/);
  store.saveSettings({...store.settings(),live:true});
  assert.doesNotThrow(()=>live.require());
});
