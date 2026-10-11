# Socialite Cloud

The Cloudflare version of Socialite. It runs online at `https://socialite.<subdomain>.workers.dev`, so no PC, tunnel or startup script is needed. Reply drafts come from your Hugging Face ZeroGPU Space.

The local app in `../Automation` is separate and unchanged. Only one of the two receives Facebook comments at a time (see [Switching between the apps](#switching-between-the-apps)).

## How it works

| Part | Where |
|---|---|
| Dashboard | `public/`, served as static files |
| Sign-in | `public/login.html`, one owner password (PBKDF2 hash) and a secure session cookie |
| API, webhook and background work | `src/index.js`: a Worker plus one SQLite-backed Durable Object (`SocialiteApp`) |
| Comments, settings, reply memory | SQLite inside the Durable Object |
| Page token, App Secret, HF token | Durable Object storage, encrypted at rest and never sent to the dashboard |
| Drafting loop | Durable Object alarm every 15 seconds; a cron runs every 5 minutes as a watchdog |
| AI | `hf-space/`, the Space running Qwen3.5-9B on ZeroGPU (`YinKci/socialite-replies`) |

These files are the same code as the local app: `src/workflow.js`, `src/facebook.js`, `src/memory.js`, `src/reactions.js`, `src/reply-text.js`, `src/store.js` and `src/hf.js`. The reply rules in `src/prompt.js` are copied word for word. The Cloudflare-only parts are `src/index.js`, `src/db.js` (Durable Object SQLite adapter and secret storage) and `src/auth.js`.

## Commands

```powershell
npm install          # once
npm test             # unit tests (Node)
npx wrangler dev     # run locally with the real Cloudflare runtime (uses .dev.vars)
npx wrangler deploy  # publish
npx wrangler tail    # live logs
```

`.dev.vars` (local only, not deployed) holds test values for `SETUP_CODE` and `IMPORT_TOKEN`.

## Secrets

| Secret | Purpose |
|---|---|
| `SETUP_CODE` | Required once, to create the dashboard password on first sign-in |
| `IMPORT_TOKEN` | Enables `/internal/import` for copying data from the local app. Delete it after importing: `npx wrangler secret delete IMPORT_TOKEN` |

Copy data from the local app (its data is opened read-only):

```powershell
npx wrangler secret put IMPORT_TOKEN
node scripts/import-from-local.js https://socialite.<subdomain>.workers.dev <import-token>
npx wrangler secret delete IMPORT_TOKEN
```

## Switching between the apps: Live On/Off

Both apps have a **Live** switch at the top of the dashboard. Only one app is live at a time.

- **Live On:** Facebook comments come to this app, and it drafts, posts and likes replies.
- **Live Off:** everything stops here (no drafts, posts or Likes, and no new comments). History and settings stay visible.
- Turning one app **On** points the Meta webhook at it. The other app checks every minute where comments go and switches itself **Off**.
- The local startup script (`Automation\autostart.vbs`) only reconnects comments to your PC when the local app is Live On.

## Limits (free plans)

- **Hugging Face:** about 5 minutes of ZeroGPU time a day, roughly 50-100 drafts. A sleeping Space takes a few minutes to wake up for the first draft.
- **Cloudflare:** 100,000 requests a day and 100,000 database row writes a day.
- **Facebook:** the Page token expires. Paste a new one in Connections → Facebook Page.
