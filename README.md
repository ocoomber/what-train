# My Train

A zero-typing Progressive Web App that tells a UK rail passenger **what train
they're on** and **what's coming next**. Built for one-handed use on a moving
train with poor signal: it opens full-screen, fires GPS automatically, and never
shows a keyboard.

## How it works

The app reads your GPS speed and heading and resolves into one of three states:

1. **At a station** (stopped, within ~300 m of a known station) — shows live
   departures as big tappable cards. Tap the one you're boarding.
2. **On a moving train** (30 mph+) — guesses which train you're on from the
   nearest station's board, filtered by your direction of travel, and asks
   *"Are you on this train?"* with **YES** / **NOT THIS ONE**. If it can't guess
   confidently, it falls back to a tappable list of nearby departures.
3. **Train confirmed** — locks onto that specific service and shows the next
   stop, the stop after, and the final destination with live ETAs and delay
   status, auto-refreshing every 60 seconds.

## Architecture

- **`worker/`** — a Cloudflare Worker that proxies the next-generation
  [Realtime Trains API](https://api-portal.rtt.io/) (`data.rtt.io`, spec v2),
  keeping the bearer token server-side (RTT's terms require this) and adding CORS
  + brief edge caching. Supports either a long-life access token or a refresh
  token (which it exchanges for short-life access tokens automatically).
- **`public/`** — a vanilla-JS PWA (no frameworks) for Cloudflare Pages: app
  shell + service worker for offline launch, a bundled UK station-coordinate
  dataset (`stations.json`), and the geolocation state machine in `app.js`.

There is no build step. See **[DEPLOY.md](DEPLOY.md)** for setup and deployment.

## Design

Dark departure-board aesthetic: background `#0a0d12`, yellow `#F5D020`, monospace,
large thumb-sized tap targets. No inputs, dropdowns, or anything that summons a
keyboard.

## Credits

Station coordinates derived from the public
[UK-Train-Station-Locations](https://github.com/ellcom/UK-Train-Station-Locations)
dataset. Train data from [Realtime Trains](https://www.realtimetrains.co.uk/).
