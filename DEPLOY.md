# Deploying My Train

This deploys as a **single Cloudflare Worker** that serves the static PWA *and*
the RTT API together (Workers Static Assets). The static files in `public/` are
served directly; anything under `/api/*` is handled by the Worker in
`src/index.js`, which proxies Realtime Trains with your token kept server-side.
So there's one thing to deploy, no separate API service, and no CORS to manage.

You'll need:
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free).
- A **Realtime Trains API token** — register at [api-portal.rtt.io](https://api-portal.rtt.io/)
  (requires an RTT unified login). You'll get **either** a long-life *access token*
  **or** a *refresh token*; both are supported.

> **Which API is this?** The next-generation RTT API at `https://data.rtt.io`
> (spec v2), authenticated with a **Bearer token**. It replaces the old
> `api.rtt.io` username/password API, which shuts down **30 September 2026**.

---

## Deploy (Cloudflare dashboard, connected to GitHub)

1. **Workers & Pages → Create → Workers → Import a repository** (connect GitHub
   if asked) and pick **`ocoomber/what-train`**.
2. On the "Set up your application" screen:
   - **Project name:** `what-train`
   - **Build command:** leave blank
   - **Deploy command:** `npx wrangler deploy` (the default — leave it)
3. Click **Deploy** and wait for the build to finish. You'll get a
   `https://what-train.<your-subdomain>.workers.dev` URL.
4. Add your RTT token: open the Worker → **Settings → Variables and Secrets** →
   **Add**:
   - **Type:** Secret (encrypted)
   - **Name:** `RTT_ACCESS_TOKEN` (if RTT gave you an access token) **or**
     `RTT_REFRESH_TOKEN` (if a refresh token)
   - **Value:** paste your token → **Save**.
5. **Redeploy so the secret takes effect:** on the Worker, open **Deployments**
   (or **View build history**) and re-run the latest deployment. A secret added
   after the first build isn't live until you redeploy.

### Check it worked

- `https://what-train.<your-subdomain>.workers.dev/api/health` → `{"ok":true}`
  (confirms the Worker deployed).
- `https://what-train.<your-subdomain>.workers.dev/api/board/CLJ` → JSON with a
  `services` array (this is the call that uses your token). If you instead see
  `{"error":"Missing RTT_ACCESS_TOKEN..."}`, the secret isn't set or you haven't
  redeployed since adding it (step 5).
- The main URL (no `/api/...`) should load the app.

---

## Install on Android

1. Open the `…workers.dev` URL in Chrome.
2. Chrome menu → **Add to Home screen**.
3. Launch from the icon — it opens full-screen and asks for **location**
   permission. Allow it ("while using" is fine). That's the only tap needed.

---

## Local development (optional, needs a terminal)

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in your RTT token (access OR refresh)
npx wrangler dev                 # serves the site + API at http://localhost:8787
```

`.dev.vars` is read automatically and is gitignored. To exercise the three
states without being on a train, open Chrome DevTools → **More tools → Sensors**
and override geolocation (and, while moving, speed/heading):

- A station's lat/long at ~0 mph → **State 1** (departure cards).
- A mid-route point at 60 mph → **State 2** (best-guess card → fallback list).
- Tap a train → **State 3** (next / then / final ETAs, 60-second auto-refresh).

---

## Updating the station data (optional)

Station coordinates are bundled in `public/stations.json` (CRS + name + lat/long,
from the public [UK-Train-Station-Locations](https://github.com/ellcom/UK-Train-Station-Locations)
dataset). Refresh it by re-downloading that dataset and re-running the transform
used to build it.

## Regenerating icons (optional)

```bash
node tools/gen-icons.js   # writes public/icons/icon-192.png and icon-512.png
```
