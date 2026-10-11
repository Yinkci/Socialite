// Transfers only the selected local ChatGPT OAuth session. Never prints token values.
// Supply SOCIALITE_IMPORT_TOKEN through the process environment, never a command-line argument.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [target,automation='C:/Users/jacob/Documents/Automation']=process.argv.slice(2);
const token=process.env.SOCIALITE_IMPORT_TOKEN;
if(!target||!token){console.error('Usage: set SOCIALITE_IMPORT_TOKEN, then run node scripts/import-chatgpt-from-local.js <app-url> [path-to-Automation]');process.exit(1);}
const url=new URL(target);
if(url.protocol!=='https:'){console.error('The online app URL must use HTTPS.');process.exit(1);}
const {Vault}=await import(pathToFileURL(join(automation,'src','vault.js')).href);
const session=new Vault(join(automation,'data')).get('chatgpt');
if(!session?.access_token||!session?.refresh_token||!session.scopes?.includes('chatgpt.tokens.use.direct')){
  console.error('Sign in and allow ChatGPT plan usage in the local app first.');process.exit(1);
}
const response=await fetch(new URL('/internal/import-chatgpt',url),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({session})});
const result=await response.json().catch(()=>({}));
if(!response.ok){console.error('Transfer failed ('+response.status+'): '+(result.error||'unknown error'));process.exitCode=1;}
else if(result.checkError){console.error('Session transferred, but ChatGPT check failed: '+result.checkError);process.exitCode=1;}
else console.log('ChatGPT session transferred; a private test draft completed. Available models: '+result.modelCount);
