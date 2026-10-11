import test from 'node:test';
import assert from 'node:assert/strict';
import { AIRouter } from '../src/ai.js';

test('Reply AI choice controls provider use and fallback',async()=>{
  let provider='chatgpt',chatgptReady=true,hfReady=true,failChatGPT=false;
  const calls=[],logs=[];
  const ai=new AIRouter({settings:()=>({aiProvider:provider}),log:message=>logs.push(message)},
    {status:()=>({enabled:chatgptReady}),generate:async()=>{calls.push('chatgpt');if(failChatGPT)throw new Error('limit');return 'ChatGPT draft';}},
    {configured:()=>hfReady,generate:async()=>{calls.push('huggingface');return 'HF draft';}});
  assert.equal(await ai.generate({aiProvider:'chatgpt'},{}),'ChatGPT draft');
  provider='huggingface';assert.equal(await ai.generate({aiProvider:'huggingface'},{}),'HF draft');
  provider='fallback';failChatGPT=true;
  assert.equal(await ai.generate({aiProvider:'fallback'},{}),'HF draft');
  assert.deepEqual(calls,['chatgpt','huggingface','chatgpt','huggingface']);
  assert.equal(logs.length,1);
  provider='chatgpt';
  await assert.rejects(ai.generate({aiProvider:'chatgpt'},{}),/limit/);
  chatgptReady=false;assert.equal(ai.status().enabled,false);
  provider='fallback';assert.equal(ai.status().enabled,true);
  hfReady=false;assert.equal(ai.status().enabled,false);
});
