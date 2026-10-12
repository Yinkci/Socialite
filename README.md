# Socialite Cloud

The Cloudflare version of Socialite. It runs online at `https://socialite.<subdomain>.workers.dev`, so no PC, tunnel or startup script is needed. In Connections, Reply AI can use ChatGPT, Hugging Face, or ChatGPT with Hugging Face as backup.

The local app in `../Automation` is separate and unchanged. Only one of the two receives Facebook comments at a time (see [Switching between the apps](#switching-between-the-apps)).

## How it works

| Part | Where |
|---|---|
| Dashboard | `public/`, served as static files |
| Sign-in | `public/login.html`, one owner password (PBKDF2 hash) and a secure session cookie |
| API, webhook and background work | `src/index.js`: a Worker plus one SQLite-backed Durable Object (`SocialiteApp`) |
| Comments, settings, reply memory | SQLite inside the Durable Object |
| Page token, App Secret, HF token, copied ChatGPT session | Durable Object storage, encrypted at rest and never sent to the dashboard |
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

The Cloudflare overview card reads account-wide Durable Objects database usage through the Analytics API and shares a five-minute memory cache across devices. It does not scan comment history. Its allowances are the Workers Free plan's 5 million rows read and 100,000 rows written per UTC day; change these figures if the account moves to Paid. Analytics may lag a few minutes, and failed updates are explicitly marked stale.

To enable the card, create a custom API token in **My Profile → API Tokens** with **Account Analytics: Read**, restricted to the **Socialite** account. Save it securely with `npx.cmd wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN`, then redeploy. Do not use an R2 storage token or the temporary Wrangler OAuth credential. Without the token, the card displays unavailable rather than inventing usage numbers.

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

## Experimental ChatGPT plan session transfer

OpenAI documents protected session transfer for a self-hosted VM, but does not document this Cloudflare Worker arrangement. The local app must already be signed in with ChatGPT plan usage. This copies its OAuth session to the online app; it can stop working and may require signing in again locally. Choose **ChatGPT + Hugging Face** in Connections to try ChatGPT first, then Hugging Face when ChatGPT fails. No API key is used.

Deploy the updated Worker, then temporarily set `IMPORT_TOKEN` as a Worker secret and deploy again so the Durable Object receives the new binding. Pass that same value to the transfer script through the `SOCIALITE_IMPORT_TOKEN` environment variable, run `node scripts/import-chatgpt-from-local.js https://socialite.<subdomain>.workers.dev`, and delete the Worker secret immediately afterward. The script reads the Windows-protected local session and sends it directly to the Worker over HTTPS without writing another credential file or printing tokens. It verifies a private test draft before reporting success. In Connections, **Test ChatGPT** checks model access; **Remove copied session** deletes the online copy without revoking the local app's sign-in.

[OpenAI's documented VM transfer](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) and [plan usage eligibility](https://developers.openai.com/siwc/token-sharing-open-source) describe the supported paths.

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
