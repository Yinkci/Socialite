import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/prompt.js';
import { WINE_AND_SILENCE_PERSONALITY } from '../src/personality-presets.js';
import { meaningCases } from './fixtures/reply-meaning-cases.js';

test('regeneration retains the exact caption and comment while prioritizing their meaning over examples',()=>{
  for(const style of ['', 'wine-and-silence']){
    const fixture=meaningCases[0];
    const {instructions,requestInput}=buildPrompt({personality:style?WINE_AND_SILENCE_PERSONALITY:'Warm, with a hopeful life lesson',examples:'Kindness always comes back to you.'},{context:fixture.post,message:fixture.comment,manualRequest:true,personalityPreset:style,previousReplies:[fixture.previous],replyMemory:{examples:[{reply:'Good people always receive kindness in return.'}]}});
    assert.equal(requestInput.post,fixture.post);assert.equal(requestInput.comment,fixture.comment);
    assert.deepEqual(requestInput.previous_replies,[fixture.previous]);
    assert.ok(instructions.indexOf('CAPTION MEANING AND COMMENT FIT')>instructions.indexOf('Reply memory contains'));
    assert.match(instructions,/Do not strengthen "not always" into "never"/);
    assert.match(instructions,/For a short expression of agreement/);
    assert.match(instructions,/If the commenter shares a different experience or disagrees/);
    assert.match(instructions,/needs_review=true/);
    assert.equal('personality' in requestInput,false);
  }
});

test('meaning guidance does not turn grammar-only corrections into rewriting a caption',()=>{
  const {instructions,requestInput}=buildPrompt({personality:WINE_AND_SILENCE_PERSONALITY},{grammarOnly:true,ownerInstructions:'I deserves respect.',context:meaningCases[0].post,message:meaningCases[0].comment});
  assert.deepEqual(requestInput,{text_to_correct:'I deserves respect.'});
  assert.match(instructions,/Correct only spelling, grammar, and punctuation/);
  assert.ok(!instructions.includes('CAPTION MEANING AND COMMENT FIT'));
});
