# CLAUDE.md

This repo deploys straight from `main` with no separate release branch — when
asked to ship a feature branch, merge it into `main` and push once it's
verified working.

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
