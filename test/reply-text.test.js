import test from 'node:test';
import assert from 'node:assert/strict';
import {withoutEmDashes,isOneWordReply,countWords} from '../src/reply-text.js';
test('em dash replacement preserves words, emojis, ordinary hyphens, and clean sentence punctuation',()=>{
 for(const [input,expected] of [['Hello\u2014friend','Hello, friend'],['Hello \u2014 friend','Hello, friend'],['Hello.\u2014Friend','Hello. Friend'],['\u2014Hello\u2014','Hello'],['Take care, friend.','Take care, friend.'],['One-moment-at-a-time','One-moment-at-a-time'],['Here\u2014still here ??','Here, still here ??']])assert.equal(withoutEmDashes(input),expected);
});

test('one-word detection ignores emojis and punctuation but supports multilingual word segmentation',()=>{
 for(const value of ['Yes','Yes ??','Amen!','????','...','Thanks'])assert.equal(isOneWordReply(value),true);
 for(const value of ['Thank you.','I hear you.','You matter ??'])assert.equal(isOneWordReply(value),false);
});

test('comment words exclude complete emoji sequences, including flags, skin tones and numeric keycaps',()=>{
  for(const value of ['Amen 😳','🙏 Amen ❤️','Amazing!!!','Thanks👍🏽','1️⃣ Amen 2️⃣','#Amen','நன்றி 🤍','谢谢 ❤️'])assert.equal(countWords(value),1,value);
  for(const value of ['🙏❤️','🇵🇭','👨‍👩‍👧‍👦','1️⃣ 2️⃣'])assert.equal(countWords(value),0,value);
  for(const value of ['Thank you 🙏','Amen🙏Thanks','So true ❤️'])assert.equal(countWords(value),2,value);
});
