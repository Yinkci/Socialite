import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPT } from '../src/chatgpt.js';

const session={client_id:'oaiapp_test',subject:'owner',email:'owner@example.com',access_token:'access',refresh_token:'refresh',scopes:['chatgpt.tokens.use.direct'],expires_at:Date.now()+3600000};
const vault=()=>{const values=new Map();return {get:key=>values.get(key),set:(key,value)=>values.set(key,value)};};

test('copied ChatGPT session imports only with plan permission and can be removed',()=>{
  const ai=new ChatGPT(vault());
  assert.throws(()=>ai.importSession({...session,scopes:[]}));
  ai.importSession(session);
  assert.equal(ai.status().enabled,true);
  assert.equal(ai.status().email,session.email);
  ai.disconnect();
  assert.equal(ai.status().enabled,false);
});

test('ChatGPT refreshes an expired copied session and saves the new token',async()=>{
  const store=vault();
  const ai=new ChatGPT(store,async(url,options)=>{
    assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');
    assert.equal(new URLSearchParams(options.body).get('refresh_token'),'refresh');
    return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  });
  ai.importSession({...session,expires_at:Date.now()-1});
  assert.equal(await ai.access(),'new-access');
  assert.equal(store.get('chatgpt').refresh_token,'new-refresh');
});

test('ChatGPT checks completion before accepting a streamed draft',async()=>{
  const ai=new ChatGPT(vault(),async url=>{
    if(url.endsWith('/models'))return Response.json({models:[{slug:'test-model',visibility:'list'}]});
    if(url.endsWith('/responses'))return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify({reply:'Thank you for sharing this.',needs_review:false,reply_decision:'REPLY'})})+'\n\n');
    throw new Error('Unexpected request');
  });
  ai.importSession(session);
  await assert.rejects(ai.generate({personality:'',knowledge:'',examples:''},{message:'Thanks',context:''}),/interrupted/);
});
