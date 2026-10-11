import test from 'node:test';
import assert from 'node:assert/strict';
import {withoutEmDashes,isOneWordReply} from '../src/reply-text.js';
test('em dash replacement preserves words, emojis, ordinary hyphens, and clean sentence punctuation',()=>{
 for(const [input,expected] of [['Hello\u2014friend','Hello, friend'],['Hello \u2014 friend','Hello, friend'],['Hello.\u2014Friend','Hello. Friend'],['\u2014Hello\u2014','Hello'],['Take care, friend.','Take care, friend.'],['One-moment-at-a-time','One-moment-at-a-time'],['Here\u2014still here ??','Here, still here ??']])assert.equal(withoutEmDashes(input),expected);
});

test('one-word detection ignores emojis and punctuation but supports multilingual word segmentation',()=>{
 for(const value of ['Yes','Yes ??','Amen!','????','...','Thanks'])assert.equal(isOneWordReply(value),true);
 for(const value of ['Thank you.','I hear you.','You matter ??'])assert.equal(isOneWordReply(value),false);
});
