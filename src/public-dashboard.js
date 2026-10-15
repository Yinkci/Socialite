// Explicit allowlists: never spread owner settings, credentials or comment internals
// into a response that visitors can read, including through browser network tools.
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
export function publicDashboard(snapshot,comments,usage){
  return {
    app:'Socialite',readOnly:true,
    settings:pick(snapshot.settings,['pageId','mode','aiProvider']),
    replyAI:pick(snapshot.replyAI,['provider','enabled']),
    chatgpt:{enabled:!!snapshot.chatgpt?.enabled},
    huggingface:{},
    facebook:pick(snapshot.facebook,['configured','pageName','followersCount','followersUpdatedAt','pageCreatedAt','followersHistory','followersDailyGains','followersDelta24h','followersHistoryReady','followersObservedChange','followersTrackingSince']),
    live:pick(snapshot.live,['on','receiving']),
    comments:comments.filter(c=>c.source==='facebook'&&c.status==='published'&&c.publish_kind==='automatic'&&!c.cleared_at).map(c=>pick(c,[
      'id','author','source','post_id','post_url','post_image','post_loaded','created_at',
      'message','context','draft','status','publish_kind','published_at','updated_at',
      'reaction_applied','reaction_status','like_after_publish',
    ])),
    tabCounts:pick(snapshot.tabCounts,['new','pending','published','automatic','approved','rejected','skipped']),
    kpiTimes:pick(snapshot.kpiTimes,['new','pending','published','automatic']),
    activity:[],
    cloudflare:pick(usage,['available','reads','writes','readLimit','writeLimit','updatedAt','resetAt','stale']),
  };
}
