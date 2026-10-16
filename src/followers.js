const DAY=86400e3;
const SGT=8*3600e3;
const midnight=now=>Math.floor((now+SGT)/DAY)*DAY-SGT;
const boundaryReading=(points,time)=>{const p=points.findLast(p=>p[0]<=time);return p&&time-p[0]<=15*60000?p:null;};
const valid=p=>Array.isArray(p)&&p.length===2&&Number.isSafeInteger(p[0])&&Number.isSafeInteger(p[1])&&p[1]>=0;
export function followerReadings(readings,now=Date.now()){
  const points=new Map();
  for(const p of Array.isArray(readings)?readings:[])if(valid(p)&&p[0]>=now-32*DAY&&p[0]<=now)points.set(p[0],p[1]);
  const sorted=[...points].sort((a,b)=>a[0]-b[0]),anchors=new Map(),end=midnight(now);
  // Keep midnight samples for daily gains without storing a month of five-minute readings.
  for(let i=0;i<=30;i++){const p=boundaryReading(sorted,end-i*DAY);if(p)anchors.set(p[0],p);}
  const older=sorted.findLast(p=>p[0]<now-26*3600e3&&p[0]>=now-7*DAY);
  if(older)anchors.set(older[0],older);
  const recent=sorted.filter(p=>p[0]>=now-26*3600e3&&!anchors.has(p[0])).slice(-(400-anchors.size));
  return [...anchors.values(),...recent].sort((a,b)=>a[0]-b[0]);
}
export function followerMetrics(page,now=Date.now()){
  const history=followerReadings([...(Array.isArray(page?.followersHistory)?page.followersHistory:[]),[page?.followersUpdatedAt,page?.followersCount]],now);
  const cutoff=now-DAY,baseline=boundaryReading(history,cutoff);
  const current=Number.isSafeInteger(page?.followersCount)&&page.followersCount>=0;
  const observed=baseline||history[0];
  const chartCutoff=Math.floor(now/3600e3)*3600e3-DAY,chartBaseline=history.findLast(p=>p[0]<=chartCutoff);
  const end=midnight(now);
  const followersDailyGains=Array.from({length:30},(_,i)=>{const t=end-(29-i)*DAY,a=boundaryReading(history,t-DAY),b=boundaryReading(history,t);return [t,a&&b?b[1]-a[1]:null];});
  return {followersHistory:[...(chartBaseline?[chartBaseline]:[]),...history.filter(p=>p[0]>chartCutoff)],followersDailyGains,
    followersDelta24h:baseline&&current?page.followersCount-baseline[1]:null,
    followersObservedChange:observed&&current?page.followersCount-observed[1]:null,
    followersTrackingSince:observed?.[0]??null,
    followersHistoryReady:!!baseline&&current};
}
export function importFollowerReadings(page,readings,now=Date.now()){
  if(!Array.isArray(readings)||readings.length>400||readings.some(p=>!valid(p)||p[0]>now||p[0]<now-7*DAY))throw Error('Invalid follower history.');
  const known=followerReadings([...(page?.followersHistory||[]),[page?.followersUpdatedAt,page?.followersCount]],now);
  if(!readings.some(p=>known.some(k=>k[0]===p[0]&&k[1]===p[1])))throw Error('Follower history does not match a saved Facebook reading.');
  // Facebook readings already saved on the server win timestamp conflicts.
  return followerReadings([...readings,...(page.followersHistory||[]),[page.followersUpdatedAt,page.followersCount]],now);
}
