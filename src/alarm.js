// An exhausted storage allowance can leave an alarm timestamp behind after its retries stop.
// Recover an overdue alarm without disturbing a work pass that is still running.
export async function ensureWorkAlarm(storage,now=Date.now()) {
  let at=await storage.getAlarm();
  if(at===null||at<now-5*60*1000){
    if(at!==null)console.warn('Recovering overdue background alarm');
    at=now+15000;
    await storage.setAlarm(at);
  }
  return at;
}
