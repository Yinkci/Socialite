import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const ITERATIONS=100000;

export const randomToken=(bytes=32)=>randomBytes(bytes).toString('base64url');
export const sha256=text=>createHash('sha256').update(String(text)).digest('hex');

async function derive(password,salt,iterations) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  return Buffer.from(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));
}

// Stored as pbkdf2$iterations$salt$hash (base64url).
export async function hashPassword(password) {
  const salt=randomBytes(16);
  return ['pbkdf2',ITERATIONS,salt.toString('base64url'),(await derive(password,salt,ITERATIONS)).toString('base64url')].join('$');
}

export async function verifyPassword(password,stored) {
  const [kind,iterations,salt,hash]=String(stored||'').split('$');
  if(kind!=='pbkdf2'||!salt||!hash) return false;
  const actual=await derive(String(password),Buffer.from(salt,'base64url'),Number(iterations));
  const expected=Buffer.from(hash,'base64url');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
