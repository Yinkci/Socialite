// Copies settings, comment history, reply memory and secrets from the local Automation app
// into this Cloudflare app. The local app's data is opened read-only and is never changed.
// Usage: node scripts/import-from-local.js <app-url> <import-token> [path-to-Automation]
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [target, token, automation='C:/Users/jacob/Documents/Automation'] = process.argv.slice(2);
if(!target||!token) {console.error('Usage: node scripts/import-from-local.js <app-url> <import-token> [path-to-Automation]');process.exit(1);}
const dataDir=join(automation,'data');
if(!existsSync(join(dataDir,'studio.sqlite'))) {console.error('Local app data not found in '+dataDir);process.exit(1);}

const db=new DatabaseSync(join(dataDir,'studio.sqlite'),{readOnly:true});
const all=(sql)=>{try{return db.prepare(sql).all();}catch{return [];}};
const {aiProvider,localUrl,localModel,localModelPath,model,...settings}=JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value);
const data={
  settings,
  comments:all('SELECT * FROM comments'),
  activity:all('SELECT * FROM activity ORDER BY id DESC LIMIT 200'),
  reply_memory:all('SELECT * FROM reply_memory'),
  memory_excluded:all('SELECT * FROM memory_excluded'),
};
db.close();

// The local vault is encrypted for this Windows account; reading it does not modify it.
const { Vault } = await import(pathToFileURL(join(automation,'src','vault.js')).href);
const vault=new Vault(dataDir);
data.vault=Object.fromEntries(['facebookToken','appSecret','verifyToken','hfToken'].map(k=>[k,vault.get(k)]).filter(([,v])=>v));

console.log(`Sending ${data.comments.length} comments, ${data.reply_memory.length} memory examples, ${data.activity.length} activity entries, secrets: ${Object.keys(data.vault).join(', ')}`);
const response=await fetch(target.replace(/\/+$/,'')+'/internal/import',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
const result=await response.text();
console.log(response.status,result);
if(!response.ok) process.exitCode=1;
