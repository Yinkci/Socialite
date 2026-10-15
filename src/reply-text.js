// Final punctuation rule for every public reply, including owner edits.
export const withoutEmDashes=text=>String(text??'')
  .replace(/[ \t]*\u2014+[ \t]*/g,', ')
  .replace(/([.!?;,:])\s*,[ \t]*/g,'$1 ')
  .replace(/,[ \t]*([.!?;,:])/g,'$1')
  .replace(/^,[ \t]*|,[ \t]*$/g,'').trim();


const wordSegmenter=new Intl.Segmenter(undefined,{granularity:'word'});
const graphemeSegmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
export function countWords(text){
  // Replace complete emoji sequences with spaces, so Amen🙏Thanks stays two
  // words and numeric keycaps such as 1️⃣ are not counted as written words.
  const written=[...graphemeSegmenter.segment(String(text??''))].map(part=>/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20e3]/u.test(part.segment)?' ':part.segment).join('');
  return [...wordSegmenter.segment(written)].filter(part=>part.isWordLike).length;
}
export const isOneWordReply=text=>countWords(text)<2;
export const isSimpleAcknowledgment=text=>/^(yes|yep|yeah|amen|thanks|thank you|true|exactly|indeed|agree|agreed|ok|okay|right)$/i.test(String(text??'').normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim());
