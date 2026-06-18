# Deploying My Train

This is a **single** Cloudflare Pages deployment. The app's API runs as a Pages
Function inside the same site (`functions/api/*`), so there's no separate Worker
to manage and nothing to wire together — you deploy the site, set one secret, done.

You'll need:
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free).
- A **Realtime Trains API token** — register at [api-portal.rtt.io](https://api-portal.rtt.io/)
  (requires an RTT unified login). You'll get **either** a long-life *access token*
  **or** a *refresh token*; the app supports both.

> **Which API is this?** The next-generation RTT API at `https://data.rtt.io`
> (spec v2), authenticated with a **Bearer token** kept server-side in the Pages
> Function. It replaces the old `api.rtt.io` username/password API, which shuts
> down **30 September 2026**.

---

## Deploy (all in the Cloudflare dashboard)

1. **Workers & Pages → Create → Pages tab → Connect to Git.**
2. Authorize GitHub if asked, then pick the **`ocoomber/what-train`** repo.
3. Production branch: **`main`**.
4. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave blank)*
   - **Build output directory:** `public`
5. Click **Save and Deploy**. Wait for the build to finish — you'll get a
   `https://<name>.pages.dev` URL.
6. Add your RTT token: open the new Pages project → **Settings → Variables and
   Secrets** (under "Environment variables") → **Add**:
   - **Type:** Secret (encrypted)
   - **Name:** `RTT_ACCESS_TOKEN` (if RTT gave you an access token) **or**
     `RTT_REFRESH_TOKEN` (if a refresh token)
   - **Value:** paste your token → **Save**.
7. **Redeploy so the secret takes effect:** Pages project → **Deployments** →
   on the latest deployment, **⋯ → Retry deployment** (a secret added after the
   first build isn't live until you redeploy).

### Check it worked

- Open `https://<name>.pages.dev/api/health` → should show `{"ok":true}`.
- Open `https://<name>.pages.dev/api/board/CLJ` → should show JSON with a
  `services` array (this is the call that uses your token). If you instead see
  `{"error":"Missing RTT_ACCESS_TOKEN..."}`, the secret isn't set or you haven't
  redeployed since adding it (step 7).

---

## Install on Android

1. Open the `https://<name>.pages.dev` URL in Chrome.
2. Chrome menu → **Add to Home screen**.
3. Launch from the icon — it opens full-screen and asks for **location**
   permission. Allow it ("while using" is fine). That's the only tap needed.

---

## Local development (optional, needs a terminal)

```bash
cp .dev.vars.example .dev.vars   # then fill in your RTT token (access OR refresh)
npx wrangler pages dev public    # serves the site + functions at http://localhost:8788
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
