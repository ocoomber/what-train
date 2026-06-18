# Deploying My Train

Two pieces deploy independently, both on Cloudflare's free tier:

1. **Worker** (`worker/`) — proxies the Realtime Trains API and hides your token.
2. **PWA** (`public/`) — the static front-end, served by Cloudflare Pages.

You'll need:
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free).
- A **Realtime Trains API token** — register at the next-generation portal
  [api-portal.rtt.io](https://api-portal.rtt.io/) (requires an RTT unified login).
  You'll be issued **either** a long-life *access token* **or** a *refresh token*;
  the Worker supports both (see below).
- Node.js 18+ locally (for `wrangler`).

> **Which API is this?** This targets the next-generation RTT API at
> `https://data.rtt.io` (spec v2), authenticated with a **Bearer token**. It
> replaces the old `api.rtt.io` username/password API, which is being shut down
> on **30 September 2026**. RTT's terms require the token to stay server-side —
> which is exactly why this app routes every call through the Worker and never
> ships the token to the browser.

> **Rate limits (free tier):** 30/min, 750/hour, 9,000/day, 30,000/week. The app
> only calls the API on user action and on the 60-second refresh while a train is
> locked, and the Worker caches responses for 30s, so this is ample for personal use.

---

## 1. Deploy the Worker

```bash
cd worker

# Log in to Cloudflare (opens a browser once)
npx wrangler login

# Store your RTT token as an encrypted secret. Set ONE of these:
#  - If you were issued a long-life access token:
npx wrangler secret put RTT_ACCESS_TOKEN
#  - If you were issued a refresh token instead (the Worker will exchange it for
#    short-life access tokens automatically and cache them):
# npx wrangler secret put RTT_REFRESH_TOKEN

# (Optional) pin the API version so the response shape can't shift under you:
# npx wrangler secret put RTT_API_VERSION     # e.g. 2026-04-09

# Ship it
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.

```
https://my-train-api.<your-subdomain>.workers.dev
```

**Copy that URL** — the front-end needs it.

### Verify the Worker

```bash
# Liveness (no RTT call)
curl https://my-train-api.<your-subdomain>.workers.dev/health
# -> {"ok":true}

# Live line-up for Clapham Junction
curl https://my-train-api.<your-subdomain>.workers.dev/api/board/CLJ
# -> JSON with a "services" array

# Service detail — take a uniqueIdentity from the board above (the data-uid value)
curl "https://my-train-api.<your-subdomain>.workers.dev/api/service?uid=gb-nr:L01525:2026-06-18"
```

If the board returns real services, the proxy and your token are working.

---

## 2. Point the PWA at your Worker

Edit **`public/config.js`** and set `API_BASE` to the Worker URL from step 1:

```js
window.MYTRAIN_CONFIG = {
  API_BASE: "https://my-train-api.<your-subdomain>.workers.dev",
};
```

---

## 3. Deploy the PWA to Cloudflare Pages

The site is plain static files — there is **no build step**.

**Option A — direct upload (quickest):**

```bash
npx wrangler pages deploy public --project-name my-train
```

This prints a `https://my-train.pages.dev` URL. Open it on your Android phone and
add it to your home screen.

**Option B — Git-connected (auto-deploy on push):**

1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → connect the repo.
3. Build settings: **Build command:** *(leave empty)* · **Build output directory:** `public`.
4. Deploy. Every push to the branch redeploys.

> Whichever option you use, `public/config.js` must already contain your Worker
> URL before deploying (Option B builds straight from the repo).

---

## Install on Android

1. Open the Pages URL in Chrome.
2. Chrome menu → **Add to Home screen** (or the install prompt).
3. Launch from the home-screen icon — it opens full-screen and asks for **location**
   permission. Allow it ("while using" is fine). That's the only tap needed.

---

## Local development

```bash
# Worker
cd worker
cp .dev.vars.example .dev.vars   # then fill in your RTT token (access OR refresh)
npx wrangler dev                 # http://localhost:8787

# Front-end (separate terminal) — set API_BASE to http://localhost:8787 in config.js first
npx wrangler pages dev public    # or any static file server
```

To exercise the three states without being on a train, open Chrome DevTools →
**More tools → Sensors** and override geolocation (and, while moving, speed/heading):

- A station's lat/long at ~0 mph → **State 1** (departure cards).
- A mid-route point at 60 mph → **State 2** (best-guess card → fallback list).
- Tap a train → **State 3** (next / then / final ETAs, 60-second auto-refresh).

---

## Updating the station data (optional)

Station coordinates are bundled in `public/stations.json` (CRS + name + lat/long,
derived from the public [UK-Train-Station-Locations](https://github.com/ellcom/UK-Train-Station-Locations)
dataset). Refresh it by re-downloading that dataset and re-running the transform used
to build it (see the commit that added `stations.json`).

## Regenerating icons (optional)

PNG icons are pre-generated and committed. To rebuild them from the brand colours:

```bash
node tools/gen-icons.js   # writes public/icons/icon-192.png and icon-512.png
```
