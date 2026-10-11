import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './helpers.js';
import { HuggingFace, spaceUrl } from '../src/hf.js';

const draft={reply:'That view would make any evening feel slower.',needs_review:false,reason:'',reaction:'LIKE',sensitive_context:'NONE',reply_decision:'REPLY'};
const comment={message:'Wish I was there',context:'Quiet night, good wine.'};
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'hf-test-')), store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.saveSettings({...store.settings(),hfSpace:'Jacob/socialite-replies',aiProvider:'huggingface'});
  const vault={value:{hfToken:'hf_testtoken0123456789'},get(k){return this.value[k];},set(k,v){this.value[k]=v;}};
  return {store,vault};
}
const sse=events=>new Response(events.map(([event,data])=>`event: ${event}\ndata: ${data}\n\n`).join(''));

test('Space names and URLs map to the Space API address',()=>{
  assert.equal(spaceUrl('Jacob/socialite-replies'),'https://jacob-socialite-replies.hf.space');
  assert.equal(spaceUrl('https://huggingface.co/spaces/Jacob/my_space.v2'),'https://jacob-my-space-v2.hf.space');
  assert.equal(spaceUrl('https://jacob-socialite-replies.hf.space/'),'https://jacob-socialite-replies.hf.space');
  assert.throws(()=>spaceUrl('not a space'),/owner\/space-name/);
});

test('drafts go to the Space /draft endpoint with the token and shared reply rules',async t=>{
  const {store,vault}=setup(t); const calls=[];
  const hf=new HuggingFace(store,vault,async(url,opts={})=>{
    calls.push({url,opts});
    if(url.endsWith('/gradio_api/call/draft')) return new Response('{"event_id":"abc"}');
    return sse([['generating','null'],['complete',JSON.stringify(['Sure! '+JSON.stringify(draft)])]]);
  });
  const result=await hf.generate(store.settings(),comment);
  assert.equal(result.reply,draft.reply);
  assert.equal(calls[0].url,'https://jacob-socialite-replies.hf.space/gradio_api/call/draft');
  assert.equal(calls[0].opts.headers.Authorization,'Bearer hf_testtoken0123456789');
  const [system,user]=JSON.parse(calls[0].opts.body).data;
  assert.match(system,/You draft public replies for a Facebook Page/);
  assert.deepEqual(JSON.parse(user),{post:'Quiet night, good wine.',comment:'Wish I was there'});
  assert.equal(calls[1].url,'https://jacob-socialite-replies.hf.space/gradio_api/call/draft/abc');
});

test('a used-up ZeroGPU quota gives a clear message',async t=>{
  const {store,vault}=setup(t);
  const hf=new HuggingFace(store,vault,async url=>url.endsWith('/draft')?new Response('{"event_id":"x"}'):sse([['error','"You have exceeded your GPU quota (300s left)."']]));
  await assert.rejects(hf.generate(store.settings(),comment),/ZeroGPU daily quota is used up/);
});
