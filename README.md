# My Train

A zero-typing Progressive Web App that tells a UK rail passenger **what train
they're on** and **what's coming next**. Built for one-handed use on a moving
train with poor signal: it opens full-screen, fires GPS automatically, and never
shows a keyboard.

## How it works

The app fires GPS on open and helps you pick your train, then tracks it:

1. **Pick your train** — works standing still (on a platform or a stopped train)
   or moving. It shows the nearest station's live departures as big tappable
   cards; tap the train you're on. If you're moving fast with a clear direction,
   it leads with a best-guess *"Are you on this train?"* card (**YES** / **NOT
   THIS ONE**), with the full list always one tap away.
2. **Tracking your train** — once you tap a train it locks onto that exact
   service and shows the next stop, the stop after, and the final destination
   with live ETAs and delay status, auto-refreshing every 60 seconds. It stays
   on that train until you tap **Show me a different train**.

## Architecture

- **`public/`** — a vanilla-JS PWA (no frameworks): app shell + service worker
  for offline launch, a bundled UK station-coordinate dataset (`stations.json`),
  and the geolocation state machine in `app.js`.
- **`src/index.js`** — the Cloudflare Worker. It serves the `public/` static
  files (Workers Static Assets) and handles `/api/*` by proxying the
  next-generation [Realtime Trains API](https://api-portal.rtt.io/)
  (`data.rtt.io`, spec v2), keeping the bearer token server-side (RTT's terms
  require this). Supports either a long-life access token or a refresh token
  (exchanged for short-life access tokens automatically). Because the API and
  site share one origin, there's no separate service and no CORS to manage.

It deploys as a single Cloudflare Worker (`npx wrangler deploy`) with no build
step. See **[DEPLOY.md](DEPLOY.md)** for setup and deployment.

## Design

Dark departure-board aesthetic: background `#0a0d12`, yellow `#F5D020`, monospace,
large thumb-sized tap targets. No inputs, dropdowns, or anything that summons a
keyboard.

## Credits

Station coordinates derived from the public
[UK-Train-Station-Locations](https://github.com/ellcom/UK-Train-Station-Locations)
dataset. Train data from [Realtime Trains](https://www.realtimetrains.co.uk/).
