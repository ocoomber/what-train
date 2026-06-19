# Realtime Trains API v2 — schema notes

Read this only if you need to touch the API parsing in `public/app.js` or the
proxy in `src/index.js` and want the real response shape without guessing or
burning a request. It is **not** loaded by default — open it on demand.

> Provenance: this is reconstructed from a real, live `/api/board/:crs`
> response a user pasted into a chat session during development (not from
> RTT's published OpenAPI spec, and not from a live call made by an AI — every
> attempt by an assistant in this repo's sandbox to reach `data.rtt.io` or the
> deployed Worker directly has hit a network policy 403). The field names and
> nesting below are exactly what `public/app.js` parses today; if the two
> ever disagree, trust the code over this file and update this file to match.

## Endpoints (via the Worker proxy)

- `GET /api/board/:crs` → proxies to RTT `/rtt/location?code=gb-nr:<CRS>`,
  returns `{ services: [...] }` for a station's departure board.
- `GET /api/service?uid=<uniqueIdentity>` → proxies to RTT
  `/rtt/service?uniqueIdentity=...`, returns one full service with every
  calling point under `locations`.
- The Worker (`src/index.js`) passes the upstream JSON through unmodified —
  no field stripping or renaming happens server-side.

**This is the full set of upstream endpoints this app uses — not the full
RTT API.** RTT v2 exposes more than this (e.g. filtering a location board by
date/time window, searching services between two locations) that `what-train`
has no need for and this doc doesn't cover. For anything beyond what's
documented below:
- Official spec / endpoint list: the RTT API portal at
  [api-portal.rtt.io](https://api-portal.rtt.io/) (registration required —
  this is also where the bearer token in `DEPLOY.md` comes from).
- Token exchange (`/api/get_access_token`) is implemented in
  `getBearer()` (`src/index.js:27`) but isn't an RTT data endpoint itself.

## Core shape: `temporalData`

Every arrival/departure/pass event on every calling point uses the same
block, found at `<location>.temporalData.{arrival,departure,pass}`:

```json
{
  "scheduleAdvertised": "2026-06-19T14:32:00Z",
  "realtimeForecast": "2026-06-19T14:47:00Z",
  "realtimeActual": null,
  "realtimeAdvertisedLateness": 15,
  "displayAs": "ON_TIME",
  "status": "..."
}
```

- `scheduleAdvertised` — the booked/timetabled time. This is the "due"
  time a delayed train is conventionally identified by at its origin.
- `realtimeForecast` — live predicted time (present once RTT has a
  forecast); `realtimeActual` — present once the event has actually
  happened (train has departed/arrived/passed).
- Display priority used throughout `app.js` (`bestTime()`,
  `public/app.js:182`): `realtimeForecast` → `realtimeActual` →
  `scheduleAdvertised`.
- `realtimeAdvertisedLateness` is precomputed in minutes — prefer this over
  manually diffing two timestamps (`latenessMin()`, `public/app.js:187`).
- `displayAs` can be `"CANCELLED"` — checked directly
  (`public/app.js:580`, `:802`).

## Per-call-point fields

```json
{
  "location": {
    "description": "Edinburgh",
    "shortCodes": ["EDB"]
  },
  "temporalData": { "arrival": { ... }, "departure": { ... }, "pass": null },
  "locationMetadata": {
    "platform": { "planned": "11", "actual": "11" },
    "numberOfVehicles": 8,
    "allocationIndex": 0
  }
}
```

- `location.shortCodes[0]` is the 3-letter CRS code.
- `locationMetadata.platform.{planned,actual}` — actual wins
  (`platformOf()`, `public/app.js:234`).
- `locationMetadata.numberOfVehicles` — **this is the join/divide signal.**
  It changes at the exact calling point where a portion splits off or joins
  on, confirmed against a real multi-portion service. `app.js` scans for
  the first change from the next unvisited stop onward
  (`formationChangeIdx()`, `public/app.js:982`) — deliberately not from the
  start, so a join that already happened isn't reported as an upcoming split.

## Service identity

```json
"scheduleMetadata": {
  "uniqueIdentity": "gb-nr:L01525:2026-06-18",
  "trainReportingIdentity": "1A23",
  "operator": { "name": "LNER" }
}
```

- `scheduleMetadata.uniqueIdentity` is the stable ID to pass back as
  `?uid=` to `/api/service`.
- Headcode is `trainReportingIdentity` (falls back to `identity`).

## Origin / destination — multi-portion (splitting/joining) trains

**Confirmed from real data**: there is no separate "associations" field.
Instead, the top-level `origin` and `destination` arrays on a service can
each have **more than one entry** when the service splits or joins:

```json
"destination": [
  { "location": { "description": "Aberdeen", "shortCodes": ["ABD"] }, "temporalData": { "scheduleAdvertised": "...", "realtimeForecast": "..." } },
  { "location": { "description": "Inverness", "shortCodes": ["INV"] }, "temporalData": { "...": "..." } }
]
```

- `destination.length > 1` ⇒ the train divides somewhere ahead
  (`public/app.js:875`).
- A real SWR example confirmed the same on the origin side: a service with
  `origin: [Weymouth, Poole]` had joined those two portions before the
  point observed.
- Use `locationMetadata.numberOfVehicles` (above) to pinpoint *where*, not
  just *that*, the split/join happens.
- An earlier implementation guessed at an `/associat/i`-keyed field — that
  field does **not** exist in the real v2 schema. Don't reintroduce it.

## Board response top level

```json
{
  "services": [
    {
      "scheduleMetadata": { "...": "..." },
      "temporalData": { "departure": { "...": "..." } },
      "locationMetadata": { "...": "..." },
      "origin": [ { "...": "..." } ],
      "destination": [ { "...": "..." } ]
    }
  ]
}
```

Each entry in `services[]` is a flat object — origin/destination/temporalData
all sit directly on it, not nested under a "calling point" wrapper. This is
different from the single-service response below, where the same per-stop
shape appears repeated inside `locations[]`.

## Single-service response (`/api/service?uid=`)

```json
{
  "scheduleMetadata": { "...": "..." },
  "origin": [ { "...": "..." } ],
  "destination": [ { "...": "..." } ],
  "locations": [
    {
      "location": { "description": "London Kings Cross", "shortCodes": ["KGX"] },
      "temporalData": { "departure": { "...": "..." } },
      "locationMetadata": { "...": "..." }
    },
    { "...": "next calling point, same shape ..." }
  ]
}
```

- `locations[]` is the full list of calling points in order — `app.js`
  builds `stops` from this (`public/app.js:799`).
- A calling point's `temporalData.departure.realtimeActual` being set means
  the train has already left that stop (`public/app.js:809`).
- The final location's `temporalData.arrival.realtimeActual` being set means
  the journey is complete (`public/app.js:814`).

## Known gotchas already hit during development

- Don't scan `locations[]` for the formation/vehicle-count change from
  index 0 — only scan from the next unvisited stop forward, or an
  already-passed join gets misreported as an upcoming split.
- RTT doesn't document a rate-limit header in its public spec; the Worker
  forwards anything matching `/ratelimit/i` under `x-rtt-*` rather than
  hardcoding a guessed header name (`src/index.js:49`).
- A `204` from upstream means "no services" — treat as `{ services: [] }`,
  not an error.
