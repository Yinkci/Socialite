import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.js';

// Tests use node:sqlite; on Cloudflare the same Store runs on the Durable Object's SQLite (src/db.js).
export const openStore=dir=>new Store(new DatabaseSync(join(dir,'studio.sqlite')));
