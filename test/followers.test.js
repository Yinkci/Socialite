import test from 'node:test';
import assert from 'node:assert/strict';
import { followerReadings, followerMetrics, importFollowerReadings } from '../src/followers.js';
import { Facebook } from '../src/facebook.js';
const now=Date.parse('2026-10-13T12:00:00Z'),hour=3600e3;

test('shared follower metrics use the last reading before the 24-hour cutoff',()=>{
  const page={followersCount:8971,followersUpdatedAt:now,followersHistory:[[now-26*hour,8370],[now-24*hour,8381],[now-3*hour,8965]]};
  const result=followerMetrics(page,now);
  assert.equal(result.followersDelta24h,590);assert.equal(result.followersHistoryReady,true);
  assert.deepEqual(result.followersHistory,[[now-24*hour,8381],[now-3*hour,8965],[now,8971]]);
  assert.equal(followerMetrics({...page,followersCount:8380},now).followersDelta24h,-1);
});
test('partial history never labels a shorter gain as 24 hours',()=>{
  const result=followerMetrics({followersCount:8971,followersUpdatedAt:now,followersHistory:[[now-hour,8965]]},now);
  assert.equal(result.followersDelta24h,null);assert.equal(result.followersHistoryReady,false);
  assert.equal(result.followersObservedChange,6);assert.equal(result.followersTrackingSince,now-hour);
});

test('hourly graph receives the first completed-hour boundary without changing rolling 24h gain',()=>{
  const at=now+30*60000,start=now-24*hour;
  const page={followersCount:1300,followersUpdatedAt:at,followersHistory:[[start,1000],[start+30*60000,1010],[now,1290]]};
  const result=followerMetrics(page,at);
  assert.equal(result.followersHistory[0][0],start);
  assert.equal(result.followersDelta24h,290);
});

test('daily gains use complete Singapore days, preserve losses, and exclude partial days',()=>{
  const day=24*hour,end=Date.parse('2026-10-14T00:00:00+08:00'),at=end+12*hour;
  const history=[[end-3*day,1000],[end-2*day,1100],[end-day,1150],[end,1140],[at,2000]];
  const result=followerMetrics({followersCount:2000,followersUpdatedAt:at,followersHistory:history},at);
  assert.deepEqual(result.followersDailyGains.slice(-3),[[end-2*day,100],[end-day,50],[end,-10]]);
  assert.equal(result.followersDailyGains.length,30);
  const missing=followerMetrics({followersCount:1140,followersUpdatedAt:end,followersHistory:[[end-day-16*60000,1000],[end,1140]]},end);
  assert.equal(missing.followersDailyGains.at(-1)[1],null,'no daily value without a sufficiently recent midnight sample');
});

test('a month of daily boundaries survives repeated five-minute history retention within 400 readings',()=>{
  const day=24*hour,end=Date.parse('2026-10-14T00:00:00+08:00');
  let history=[];
  for(let t=end-31*day;t<=end;t+=5*60000)history=followerReadings([...history,[t,Math.round((t-(end-31*day))/hour)]],t);
  assert.ok(history.length<=400);
  const result=followerMetrics({followersCount:744,followersUpdatedAt:end,followersHistory:history},end);
  assert.equal(result.followersDailyGains.filter(p=>p[1]!==null).length,30);
  assert.ok(result.followersDailyGains.every(p=>p[1]===24));
  assert.equal(result.followersDelta24h,24);
});
test('legacy imports require the known current reading, preserve server readings and bound retention',()=>{
  const page={followersCount:8971,followersUpdatedAt:now,followersHistory:[[now-hour,8960]]};
  const points=importFollowerReadings(page,[[now-24*hour,8381],[now-hour,8950],[now,8971]],now);
  assert.equal(points.find(p=>p[0]===now-hour)[1],8960);
  assert.equal(followerMetrics({...page,followersHistory:points},now).followersDelta24h,590);
  assert.throws(()=>importFollowerReadings(page,[[now,123]],now),/does not match/);
  assert.throws(()=>importFollowerReadings(page,[[now+1,8971]],now),/Invalid/);
  assert.throws(()=>importFollowerReadings(page,Array(401).fill([now,8971]),now),/Invalid/);
  const history=followerReadings(Array.from({length:500},(_,i)=>[now-i*60000,i]),now);
  assert.equal(history.length,400);assert.equal(history.at(-1)[0],now);
  assert.deepEqual(followerReadings([[now-8*24*hour,10],[now,0],[now+1,10],['bad',20]],now),[[now,0]]);
});

test('a short legacy history is preserved and survives a simultaneous follower refresh',()=>{
  const earlier=now-10*hour;
  const page={followersCount:8974,followersUpdatedAt:now,followersHistory:[[now-60000,8971],[now,8974]]};
  const points=importFollowerReadings(page,[[earlier,8381],[now-60000,8971]],now);
  const result=followerMetrics({...page,followersHistory:points},now);
  assert.equal(result.followersDelta24h,null);assert.equal(result.followersObservedChange,593);
  assert.equal(result.followersTrackingSince,earlier);assert.equal(result.followersHistoryReady,false);
});

test('existing Facebook refresh saves shared history without another Facebook request',async()=>{
  const previous=Date.now()-24*hour-2*60000;
  let settings={pageId:'123',graphVersion:'v26.0',facebookPage:{id:'123',name:'Page',followersCount:8381,followersUpdatedAt:previous}},calls=0,writes=0;
  const fb=new Facebook({settings:()=>settings,saveSettings:s=>{settings=s;writes++;}},{get:()=> 'test-token'},async()=>{
    calls++;return {ok:true,json:async()=>({id:'123',name:'Page',followers_count:8971})};
  });
  await fb.verify(true);
  assert.equal(calls,1);assert.equal(writes,1);assert.equal(followerMetrics(settings.facebookPage).followersDelta24h,590);
  const history=settings.facebookPage.followersHistory;
  await fb.verify(false);assert.deepEqual(settings.facebookPage.followersHistory,history);
});


test('recovered snapshot readings restore the 24-hour baseline without replacing current counts',()=>{
  const at=Date.parse('2026-10-16T13:25:00+08:00');
  const page={followersCount:10194,followersUpdatedAt:at,followersHistory:[[at-63*hour,8980],[at-hour,10172],[at,10194]]};
  assert.equal(followerMetrics(page,at).followersDelta24h,null);
  const history=importFollowerReadings(page,[[at-24*hour-60000,9975],[at-hour,10170],[at,10194]],at);
  assert.equal(history.find(p=>p[0]===at-hour)[1],10172);
  const metrics=followerMetrics({...page,followersHistory:history},at);
  assert.equal(metrics.followersDelta24h,219);assert.equal(metrics.followersHistoryReady,true);
});
