// Final punctuation rule for every public reply, including owner edits.
export const withoutEmDashes=text=>String(text??'')
  .replace(/[ \t]*\u2014+[ \t]*/g,', ')
  .replace(/([.!?;,:])\s*,[ \t]*/g,'$1 ')
  .replace(/,[ \t]*([.!?;,:])/g,'$1')
  .replace(/^,[ \t]*|,[ \t]*$/g,'').trim();


const wordSegmenter=new Intl.Segmenter(undefined,{granularity:'word'});
export const isOneWordReply=text=>[...wordSegmenter.segment(String(text??''))].filter(part=>part.isWordLike).length<2;
export const isSimpleAcknowledgment=text=>/^(yes|yep|yeah|amen|thanks|thank you|true|exactly|indeed|agree|agreed|ok|okay|right)$/i.test(String(text??'').normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim());
