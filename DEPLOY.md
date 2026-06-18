# Deploying My Train

Two pieces deploy independently, both on Cloudflare's free tier:

1. **Worker** (`worker/`) — proxies the Realtime Trains API and hides your credentials.
2. **PWA** (`public/`) — the static front-end, served by Cloudflare Pages.

You'll need:
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free).
- A [Realtime Trains API](https://api.rtt.io/) account — sign up, then your login
  username/password are your API credentials (HTTP Basic Auth).
- Node.js 18+ locally (for `wrangler`).

> **Note:** This targets the legacy RTT *Pull* API at `api.rtt.io`, which is what the
> username/password login is for. RTT has announced this endpoint will retire around
> September 2026; if you're reading this later, you may need to migrate to their newer
> API portal and update the base URL / auth in `worker/src/index.js`.

---

## 1. Deploy the Worker

```bash
cd worker

# Log in to Cloudflare (opens a browser once)
npx wrangler login

# Store your RTT credentials as encrypted secrets (you'll be prompted to paste each)
npx wrangler secret put RTT_USERNAME
npx wrangler secret put RTT_PASSWORD

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

# Live departures for London Paddington
curl https://my-train-api.<your-subdomain>.workers.dev/api/board/PAD
# -> JSON board with a "services" array

# Service detail — take a serviceUid + runDate from the board above
curl https://my-train-api.<your-subdomain>.workers.dev/api/service/W12345/2026/06/18
```

If the board returns real services, the proxy and your credentials are working.

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

> Whichever option you use, remember `public/config.js` must already contain your
> Worker URL before deploying (Option B builds straight from the repo).

---

## Install on Android

1. Open the Pages URL in Chrome.
2. Chrome menu → **Add to Home screen** (or the install prompt).
3. Launch from the home-screen icon — it opens full-screen and asks for **location**
   permission. Allow it ("while using" is fine). That's the only tap needed.

---

## Updating the station data (optional)

Station coordinates are bundled in `public/stations.json` (CRS + name + lat/long,
derived from the public [UK-Train-Station-Locations](https://github.com/ellcom/UK-Train-Station-Locations)
dataset). To refresh it, re-download that dataset and re-run the small transform used
to build it (see the commit that added `stations.json`).

## Regenerating icons (optional)

PNG icons are pre-generated and committed. To rebuild them from the brand colours:

```bash
node tools/gen-icons.js   # writes public/icons/icon-192.png and icon-512.png
```

---

## Local development

```bash
# Worker
cd worker
cp .dev.vars.example .dev.vars   # then fill in your real RTT username/password
npx wrangler dev                 # http://localhost:8787

# Front-end (separate terminal) — set API_BASE to http://localhost:8787 in config.js first
npx wrangler pages dev public    # or any static file server
```

To exercise the three states without being on a train, open Chrome DevTools →
**More tools → Sensors** and override geolocation (and, while moving, speed/heading):

- A station's lat/long at ~0 mph → **State 1** (departure cards).
- A mid-route point at 60 mph → **State 2** (best-guess card → fallback list).
- Tap a train → **State 3** (next / then / final ETAs, 60-second auto-refresh).
