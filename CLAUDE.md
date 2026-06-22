# CLAUDE.md

This repo deploys straight from `main` with no separate release branch —
always merge finished work into `main` and push it there (not just the
feature branch) so the user can test on their phone, without waiting to be
asked.

## Project overview

"My Train" is a zero-typing PWA that tells a UK rail passenger what train
they're on and what's coming next.

- **`public/`** — vanilla-JS PWA (no frameworks, no build step). `app.js` holds
  the geolocation state machine and rendering; `styles.css` is the dark
  departure-board theme.
- **`src/index.js`** — Cloudflare Worker serving the static assets and proxying
  the Realtime Trains API (`data.rtt.io`, spec v2) under `/api/*`, keeping the
  bearer token server-side.

See `README.md` for the user-facing flow and `DEPLOY.md` for deployment.

## RTT API data-model gotchas

- `docs/rtt-api-sample-response.json` is a real `/api/board/:crs` response —
  use it to check field shapes instead of guessing from the (unofficial)
  spec.
- Per-service `origin[]`/`destination[]` location objects only carry
  `longCodes` (TIPLOC, e.g. `"WATRLMN"`), never `shortCodes` (3-letter CRS).
  `shortCodes` only appears on the top-level queried station
  (`query.location.shortCodes`). `public/stations.json` has no TIPLOC field,
  so matching a service's origin/destination to a station must go by name
  (`location.description`), not code — see `nameIndex` in `public/app.js`.
- This was only confirmed against board responses. `stopCrs()` in
  `public/app.js` reads `shortCodes` off the richer per-calling-point
  `locations[]` from `/api/service?uid=`, which hasn't been checked against
  a real sample — if station-tapping ("tap to set your stop") ever misbehaves,
  check this first.
