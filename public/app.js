/* My Train — vanilla JS PWA (Realtime Trains API v2 via the Worker proxy).
 *
 * Fires GPS on load (no buttons) and resolves into one of three states:
 *   1. AT A STATION  -> tappable live departures
 *   2. ON A TRAIN, UNIDENTIFIED -> best-guess card (YES / NOT THIS ONE), then fallback list
 *   3. TRAIN CONFIRMED -> next stop / stop after / destination ETAs, auto-refresh 60s
 *
 * v2 data model notes (see RTT OpenAPI spec):
 *   - times are ISO 8601 datetimes inside temporalData.{arrival,departure,pass}
 *     as scheduleAdvertised (booked), realtimeForecast/realtimeActual (live).
 *   - lateness is precomputed in minutes (realtimeAdvertisedLateness).
 *   - a service is identified by scheduleMetadata.uniqueIdentity (e.g. "gb-nr:L01525:2026-06-18").
 *   - destination[].location only carries longCodes (TIPLOC), never shortCodes (CRS);
 *     direction-ranking matches destination[].location.description against
 *     stations.json by name instead.
 */

"use strict";

const API_BASE = (window.MYTRAIN_CONFIG && window.MYTRAIN_CONFIG.API_BASE || "").replace(/\/$/, "");

const STOPPED_MPH = 3;
const MOVING_MPH = 30;
const STATION_RADIUS_M = 300;
const DIRECTION_TOLERANCE = 70;
const REFRESH_MS = 60000;

const State = { ACQUIRING: "ACQUIRING", IDLE: "IDLE", STATION: "STATION", MOVING: "MOVING", CONFIRMED: "CONFIRMED" };
let current = State.ACQUIRING;

let stations = [];           // [{c,n,y,x}]
let crsIndex = new Map();    // CRS -> {y,x}
let nameIndex = new Map();   // lowercased station name -> {y,x}
let lastFix = null;
let fixHistory = [];         // recent fixes for smoothing speed/bearing
let speedMph = 0;
let bearing = null;

let discovery = { stationCrs: null, services: null };
let candidates = [];
let candidateIdx = 0;

let locked = null;           // {uid, op, auto}
let refreshTimer = null;
let geoWatchId = null;
let lastSvc = null;          // last rendered service (QR back / signal-drop fallback)
let lastLoadedAt = 0;        // when fresh service data last arrived
let staleMsg = "";           // set when a refresh failed but we kept the old data
let pinnedStation = null;    // {crs, pos} when the user manually picked a nearby station
let pinnedTrains = loadPinnedTrains(); // [{uid, op, dest, time}] — saved candidates for quick re-find

// Opportunistic RTT rate-limit tracking — RTT's spec doesn't document a
// rate-limit header, so this only ever gets populated if the Worker actually
// forwards one (see rateLimitHeaders() in src/index.js); otherwise it stays
// null and the footer shows nothing extra.
let apiLimitInfo = null; // { remaining, limit } (strings, as RTT sent them)
function updateApiLimitInfo(headers) {
  let remaining = null, limit = null;
  headers.forEach((value, key) => {
    if (!/ratelimit/i.test(key)) return;
    if (/remaining/i.test(key)) remaining = value;
    else if (/limit/i.test(key)) limit = value;
  });
  if (remaining != null || limit != null) apiLimitInfo = { remaining, limit };
}
function apiLimitFooterHtml() {
  if (!apiLimitInfo) return "";
  const remaining = Number(apiLimitInfo.remaining);
  if (!Number.isFinite(remaining)) return "";
  const limit = Number(apiLimitInfo.limit);
  const low = Number.isFinite(limit) && limit > 0 ? remaining / limit <= 0.1 : remaining <= 20;
  if (!low) return "";
  const text = Number.isFinite(limit) && limit > 0 ? `${remaining}/${limit} calls left` : `${remaining} calls left`;
  return `<br><span class="footer-warn">⚠ Nearing RTT API limit — ${esc(text)}</span>`;
}

const $screen = document.getElementById("screen");
const $statusText = document.getElementById("status-text");
const $statusDot = document.getElementById("status-dot");
const $speed = document.getElementById("speed-readout");
const $backBtn = document.getElementById("back-btn");
const $helpBtn = document.getElementById("help-btn");

// ---------- in-app back navigation ----------
// A standalone/full-screen PWA has no browser chrome back arrow, and the
// phone's hardware/gesture back closes the app outright once there's no
// more history to pop. So every "drill into a sub-screen" tap pushes a
// closure that redraws where you came from, and a real history entry to
// match — letting both the on-screen button and the phone's back button
// step back through the app instead of exiting it.
let navStack = [];
function pushNav(renderPrev) {
  navStack.push(renderPrev);
  try { history.pushState({ navDepth: navStack.length }, ""); } catch (_) {}
  updateBackButton();
}
function clearNav() {
  navStack = [];
  updateBackButton();
}
function updateBackButton() {
  if ($backBtn) $backBtn.style.display = navStack.length ? "inline-block" : "none";
}
if ($backBtn) $backBtn.onclick = () => { if (navStack.length) history.back(); };
window.addEventListener("popstate", () => {
  if (!navStack.length) return;
  const renderPrev = navStack.pop();
  updateBackButton();
  renderPrev();
});
// Signal's back — resume the normal GPS/live-board flow from the offline fallback.
window.addEventListener("online", () => { if (current === State.IDLE) evaluate(); });

// ---------- geo helpers ----------
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.y - a.y), dLon = toRad(b.x - a.x);
  const lat1 = toRad(a.y), lat2 = toRad(b.y);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearingDeg(a, b) {
  const lat1 = toRad(a.y), lat2 = toRad(b.y), dLon = toRad(b.x - a.x);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function nearestStation(pos, maxM) {
  let best = null, bestD = Infinity;
  for (const s of stations) {
    const d = distanceM(pos, s);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (maxM != null && bestD > maxM) return null;
  return best ? { station: best, distance: bestD } : null;
}
function stationAhead(pos) {
  if (bearing == null) return nearestStation(pos);
  let best = null, bestD = Infinity;
  for (const s of stations) {
    const d = distanceM(pos, s);
    if (d < 150 || d > 30000) continue;
    if (angleDiff(bearingDeg(pos, s), bearing) <= DIRECTION_TOLERANCE && d < bestD) { bestD = d; best = s; }
  }
  return best ? { station: best, distance: bestD } : nearestStation(pos);
}

// ---------- status bar ----------
function setStatus(text, kind) {
  $statusText.textContent = text;
  $statusDot.className = "dot" + (kind ? " " + kind : "");
}
function compass(deg) { return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]; }
function updateSpeedReadout() {
  if (lastFix) $speed.textContent = `${Math.round(speedMph)} mph${bearing == null ? "" : " " + compass(bearing)}`;
}

// ---------- time helpers (ISO datetimes in v2) ----------
function parseTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function fmtClock(d) {
  return d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "--:--";
}
function etaText(d) {
  if (!d) return "";
  const m = Math.round((d.getTime() - Date.now()) / 60000);
  if (m <= 0) return "DUE";
  if (m === 1) return "1 MIN";
  if (m > 60) return fmtClock(d);
  return `${m} MIN`;
}

// ---------- v2 field extraction ----------
// Best displayed time for an IndividualTemporalData block: live forecast/actual, else booked.
function bestTime(td) {
  if (!td) return null;
  return parseTime(td.realtimeForecast) || parseTime(td.realtimeActual) || parseTime(td.scheduleAdvertised);
}
function bookedTime(td) { return td ? parseTime(td.scheduleAdvertised) : null; }
function latenessMin(td) {
  if (!td) return 0;
  if (typeof td.realtimeAdvertisedLateness === "number") return td.realtimeAdvertisedLateness;
  const b = bookedTime(td), live = parseTime(td.realtimeForecast) || parseTime(td.realtimeActual);
  return b && live ? Math.round((live - b) / 60000) : 0;
}
// Three-tier delay severity, shared by the banner and every SCH/EXP badge so
// color is never the only signal (each tier also gets a distinct icon).
function delaySeverity(min) {
  if (min >= 5) return "bad";
  if (min >= 1) return "warn";
  return "ok";
}
function severityIcon(sev) { return sev === "bad" ? "✕" : sev === "warn" ? "▲" : "✓"; }
function severityBadgeClass(sev) { return sev === "bad" ? "badge-late" : "badge-warn"; }

// ---------- pinned trains ----------
// A small saved shortlist (e.g. candidate replacements after a cancellation)
// so the user can flip straight back to one without re-scanning a station board.
const PINNED_MAX = 8;
// Pins are for "what am I about to catch", not a lifetime collection — drop
// anything older than a day (generous enough to still cover an overnight
// service) so the list can't quietly fill up with trains long gone.
const PINNED_TTL_MS = 24 * 60 * 60 * 1000;
function loadPinnedTrains() {
  try { return JSON.parse(localStorage.getItem("mytrain.pinned") || "[]"); } catch (_) { return []; }
}
function savePinnedTrains() {
  try { localStorage.setItem("mytrain.pinned", JSON.stringify(pinnedTrains)); } catch (_) {}
}
function prunePins() {
  const cutoff = Date.now() - PINNED_TTL_MS;
  const fresh = pinnedTrains.filter((p) => (p.at || 0) >= cutoff);
  if (fresh.length !== pinnedTrains.length) {
    pinnedTrains = fresh;
    savePinnedTrains();
  }
}
function isPinned(uid) { return pinnedTrains.some((p) => p.uid === uid); }
function togglePin(info) {
  prunePins();
  const i = pinnedTrains.findIndex((p) => p.uid === info.uid);
  if (i >= 0) pinnedTrains.splice(i, 1);
  else pinnedTrains.unshift({ ...info, at: Date.now() });
  if (pinnedTrains.length > PINNED_MAX) pinnedTrains.length = PINNED_MAX;
  savePinnedTrains();
}
function platformOf(meta) {
  const p = meta && meta.platform;
  return p ? (p.actual || p.planned || "") : "";
}
function destInfo(svc) {
  const d = svc.destination && svc.destination[0] && svc.destination[0].location;
  return { name: (d && d.description) || "—" };
}

// ---------- RTT API ----------
async function api(path) {
  // API_BASE is empty for same-origin (Pages Functions). Only the leftover
  // placeholder from an external-Worker setup is treated as "not configured".
  if (API_BASE.includes("example.workers.dev")) {
    throw new Error("API not configured. Set API_BASE in config.js.");
  }
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  updateApiLimitInfo(res.headers);
  if (!res.ok) {
    let msg = `Service error (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- main GPS loop ----------
function onPosition(pos) {
  const c = pos.coords;
  const fix = { y: c.latitude, x: c.longitude, t: pos.timestamp };
  fixHistory.push(fix);
  fixHistory = fixHistory.filter((f) => f.t >= fix.t - 30000).slice(-6);

  // Speed: device value if present, else averaged over the recent window.
  let mps = (typeof c.speed === "number" && c.speed >= 0) ? c.speed : null;
  if (mps == null && fixHistory.length >= 2) {
    const a = fixHistory[0], dt = (fix.t - a.t) / 1000;
    if (dt > 0) mps = distanceM(a, fix) / dt;
  }
  if (mps != null) speedMph = mps * 2.23694;

  // Bearing: device heading when moving, else net travel across the window
  // (more stable than two consecutive fixes).
  if (typeof c.heading === "number" && !isNaN(c.heading) && speedMph > STOPPED_MPH) {
    bearing = c.heading;
  } else if (fixHistory.length >= 2 && distanceM(fixHistory[0], fix) > 20) {
    bearing = bearingDeg(fixHistory[0], fix);
  }

  lastFix = fix;
  updateSpeedReadout();
  evaluate();
}

function startGeo() {
  if (!navigator.geolocation || geoWatchId != null) return;
  const opts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };
  // One quick request to get an initial fix fast, plus a continuous watch.
  navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: true, timeout: 15000 });
  geoWatchId = navigator.geolocation.watchPosition(onPosition, onPositionError, opts);
}

// Once a train is locked we no longer need GPS — stop watching to save battery
// and data. It resumes when the user asks for a different train.
function stopGeo() {
  if (geoWatchId != null && navigator.geolocation) {
    try { navigator.geolocation.clearWatch(geoWatchId); } catch (_) {}
  }
  geoWatchId = null;
}

function onPositionError(err) {
  if (current === State.CONFIRMED) return;
  if (err.code === err.PERMISSION_DENIED) {
    setStatus("NO GPS", "err");
    renderNotice("LOCATION BLOCKED", "Allow location access for this site, then reload. My Train needs GPS to find your train.", false, false, false, true);
  } else {
    setStatus("GPS ERROR", "err");
    renderNotice("WAITING FOR GPS", "Couldn't get a location fix. Move near a window if you can.", true, false, false, true);
  }
}

// When there's no signal at all, live boards/services are unreachable —
// fall back to the locally-saved pinned shortlist (the one thing that still
// works straight from localStorage) instead of spinning on GPS forever.
function showOfflineFallback() {
  current = State.IDLE;
  clearNav();
  setStatus("OFFLINE", "err");
  if (pinnedTrains.length) renderPinned();
  else renderNotice("NO INTERNET", "Can't reach live train data right now.", false, true);
}

function evaluate() {
  if (current === State.CONFIRMED) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (current !== State.IDLE) showOfflineFallback();
    return;
  }
  if (!lastFix) return;

  // Respect whatever station the user is currently looking at (set by
  // enterStation, whether reached automatically or picked manually) until
  // they move meaningfully away from it — even while moving fast or drifting
  // just past the proximity radius, so a stray GPS fix doesn't yank them out
  // of the departures board they're actively reading.
  if (pinnedStation && distanceM(lastFix, pinnedStation.pos) < 500) return;
  pinnedStation = null;

  // Genuinely close to a real station — show its live board regardless of
  // current speed. This covers standing on a platform, a stopped train, and
  // (importantly) a train pulling fast into or out of a stop: in practice
  // waiting for the next station's board and picking from it there is far
  // more reliable than guessing mid-journey, so it takes priority over the
  // moving-guess flow below.
  const near = nearestStation(lastFix, STATION_RADIUS_M);
  if (near) {
    if (current !== State.STATION || discovery.stationCrs !== near.station.c) {
      enterStation(near.station, near.distance);
    }
    return;
  }

  // Moving with a known heading, between stations: don't auto-launch the
  // best-guess train finder — it's a less fluid experience than just waiting
  // for the next station. Show a calm "on the move" screen instead, with the
  // guess flow available as an explicit, secondary "lost your train" action.
  if (speedMph >= MOVING_MPH && bearing != null) {
    if (current !== State.MOVING) enterBetweenStations();
    return;
  }

  // Standing still or slow and not close to any station (e.g. a stopped
  // train between stops) — fall back to the nearest station's board however
  // far away it is, same as before.
  const wide = nearestStation(lastFix);
  if (!wide) { showLocated(); return; }
  if (current !== State.STATION || discovery.stationCrs !== wide.station.c) {
    enterStation(wide.station, wide.distance);
  }
}

// A calm "you're between stations" screen — replaces the old behavior of
// auto-launching the best-guess train finder the moment you're moving fast.
// The finder is still one tap away, but framed as a fallback for when you
// genuinely can't wait (e.g. you forgot to pin a train at the last station).
function enterBetweenStations() {
  current = State.MOVING;
  pinnedStation = null;
  clearNav();
  prunePins();
  setStatus("ON A TRAIN", "ok");

  const ahead = stationAhead(lastFix);
  const sub = ahead
    ? `Approaching ${ahead.station.n} — live departures will appear automatically when you arrive.`
    : "Looking for the next station…";

  let html = `<div class="notice">
    <div class="big">ON THE MOVE</div>
    <div class="sub">${esc(sub)}</div>
  </div>`;
  if (pinnedTrains.length) {
    html += `<button class="btn btn-wide" id="resume-pinned">⭐ Your pinned trains (${pinnedTrains.length})</button>`;
  }
  html += `<button class="link-btn" id="find-now">🆘 Lost your train? Find it now</button>`;

  $screen.innerHTML = html;
  const rp = document.getElementById("resume-pinned");
  if (rp) rp.onclick = () => { pushNav(enterBetweenStations); renderPinned(); };
  document.getElementById("find-now").onclick = () => {
    // enterMoving() clears the nav stack as it starts its own fresh
    // discovery flow, so push the return target after calling it.
    enterMoving();
    pushNav(enterBetweenStations);
  };
}

function nearestStations(pos, count) {
  return stations
    .map((s) => ({ station: s, distance: distanceM(pos, s) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count || 6);
}

function nearbyStationRow({ station, distance }) {
  const distTxt = distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`;
  return `<button class="card station-row" data-crs="${esc(station.c)}">
    <div class="card-dest">📍 ${esc(station.n)}</div>
    <div class="card-meta"><span class="station-tag">${esc(station.c)}</span><span>${distTxt} away</span></div>
  </button>`;
}

// A pickable list of nearby stations — for when the auto-picked "station
// ahead" isn't the one the train's actually calling at next.
function renderNearbyStations() {
  if (!lastFix) { renderNotice("NO GPS FIX", "Can't list nearby stations without a location.", false, true); return; }
  const list = nearestStations(lastFix, 8);
  const rows = list.length
    ? list.map(nearbyStationRow).join("")
    : `<div class="notice"><div class="big">No stations found nearby</div></div>`;
  $screen.innerHTML = `<div class="screen-title">Nearby stations — tap one</div>${rows}`;
  $screen.querySelectorAll("[data-crs]").forEach((el) => {
    el.onclick = () => {
      const picked = list.find((x) => x.station.c === el.dataset.crs);
      if (!picked) return;
      enterStation(picked.station, picked.distance);
    };
  });
}

// A saved shortlist of trains the user starred earlier — for quickly hopping
// to a replacement after a cancellation, without re-scanning a station board.
function pinnedRow(p) {
  return `<button class="card" data-uid="${esc(p.uid)}" data-op="${esc(p.op)}">
    <div class="card-row">
      <span class="card-time">${esc(p.time)}</span>
      <span class="pin-star on" data-pin-remove="${esc(p.uid)}" title="Remove">✕</span>
    </div>
    <div class="card-dest">${esc(p.dest)}</div>
    <div class="card-meta"><span class="op-name">${esc(p.op)}</span></div>
  </button>`;
}
function renderPinned() {
  prunePins();
  const rows = pinnedTrains.length
    ? pinnedTrains.map(pinnedRow).join("")
    : `<div class="notice"><div class="big">No pinned trains</div><div class="sub">Tap ☆ on any train to save it here for quick access.</div></div>`;
  $screen.innerHTML = `<div class="screen-title">⭐ Pinned trains</div>${rows}`;
  $screen.querySelectorAll(".card[data-uid]").forEach((el) => {
    el.onclick = () => lockOnto(el.dataset.uid, el.dataset.op, false, renderPinned);
  });
  $screen.querySelectorAll("[data-pin-remove]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      togglePin({ uid: el.dataset.pinRemove });
      renderPinned();
    };
  });
}

// Rare fallback: we have a fix but no station data to list (e.g. dataset failed).
function showLocated() {
  if (current === State.IDLE) return;
  current = State.IDLE;
  clearNav();
  prunePins();
  setStatus("LOCATED", "ok");
  renderNotice("GOT YOUR LOCATION ✓", "Couldn't find any nearby stations to list. Tap to try again.", false, true);
}

// ---------- STATE 1: at a station ----------
async function enterStation(station, distance) {
  clearNav();
  prunePins();
  current = State.STATION;
  // Pin this station the same way a manual pick does (see renderNearbyStations)
  // so evaluate()'s pinned-station guard protects the departures board from
  // being yanked away by a stray speed spike or drifting just past the
  // proximity radius while the user is actively reading it — only leaving
  // requires moving meaningfully away, not a single noisy GPS fix.
  pinnedStation = { crs: station.c, pos: lastFix };
  const prevServices = discovery.stationCrs === station.c ? discovery.services : null;
  discovery = { stationCrs: station.c, services: null };
  setStatus(station.c, "ok");
  renderNotice(station.n.toUpperCase(), "Loading live trains…", true);
  try {
    const data = await api(`/api/board/${station.c}`);
    if (current !== State.STATION || discovery.stationCrs !== station.c) return;
    discovery.services = mergeBoardServices(data.services || [], prevServices);
    renderStation(station, discovery.services, distance);
  } catch (e) {
    renderNotice("CAN'T LOAD TRAINS", e.message, false, true);
  }
}

function renderStation(station, services, distance) {
  const far = typeof distance === "number" && distance > STATION_RADIUS_M;
  const distTxt = typeof distance === "number"
    ? (distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`)
    : "";
  const heading = far
    ? `${esc(station.n)} · ${distTxt} away — tap your train`
    : `${esc(station.n)} · tap the train you're on`;
  const cards = services.length
    ? services.map(departureCard).join("")
    : `<div class="notice"><div class="big">No trains listed right now</div><div class="sub">Try Reload — it may just be a quiet moment.</div></div>`;
  $screen.innerHTML =
    `<div class="screen-title">${heading}</div>${cards}` +
    `<div class="btn-row" style="margin-top:6px">
       <button class="btn" id="reload-board">↻ RELOAD</button>
       <button class="btn" id="nearby">NEARBY STATIONS →</button>
     </div>` +
    (pinnedTrains.length ? `<button class="link-btn" id="pinned-link">⭐ Pinned trains (${pinnedTrains.length})</button>` : "");
  bindCards(() => renderStation(station, services, distance));
  document.getElementById("reload-board").onclick = () => enterStation(station, distance);
  document.getElementById("nearby").onclick = () => { pushNav(() => renderStation(station, services, distance)); renderNearbyStations(); };
  const pl = document.getElementById("pinned-link");
  if (pl) pl.onclick = () => { pushNav(() => renderStation(station, services, distance)); renderPinned(); };
}

// RTT's board cuts a service off once its *booked* time passes, even if it's
// badly delayed and hasn't actually left yet — so a still-waiting train can
// vanish from a fresh fetch. Carry forward anything missing from the new
// list that we never saw an actual departure time for, so it stays visible
// until it either reappears or is confirmed gone (capped so a genuine miss
// doesn't linger forever).
const GHOST_MAX_MS = 30 * 60000;
function serviceUid(s) {
  return (s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity) || "";
}
function hasActuallyDeparted(s) {
  const dep = s.temporalData && s.temporalData.departure;
  return !!(dep && dep.realtimeActual);
}
function svcTime(s) {
  const dep = s.temporalData && s.temporalData.departure;
  const t = bestTime(dep) || bookedTime(dep);
  return t ? t.getTime() : Infinity;
}
function mergeBoardServices(fresh, prev) {
  if (!prev || !prev.length) return fresh;
  const freshUids = new Set(fresh.map(serviceUid));
  const now = Date.now();
  const carried = [];
  for (const s of prev) {
    const uid = serviceUid(s);
    if (!uid || freshUids.has(uid) || hasActuallyDeparted(s)) continue;
    const ghostSince = s.__ghostSince || now;
    if (now - ghostSince > GHOST_MAX_MS) continue;
    carried.push({ ...s, __ghostSince: ghostSince });
  }
  const merged = fresh.concat(carried);
  merged.sort((a, b) => svcTime(a) - svcTime(b));
  return merged;
}

function departureCard(s) {
  const dep = s.temporalData && s.temporalData.departure;
  const dest = destInfo(s);
  const booked = bookedTime(dep);
  const live = bestTime(dep);
  const sev = delaySeverity(latenessMin(dep));
  const cancelled = (s.temporalData && (s.temporalData.displayAs === "CANCELLED")) ||
    (dep && dep.isCancelled);
  const timeHtml = cancelled
    ? `<span class="badge-late">✕ CANCELLED</span>`
    : (sev !== "ok"
      ? `<span class="strike">${fmtClock(booked)}</span> <span class="${severityBadgeClass(sev)}">${severityIcon(sev)} ${fmtClock(live)}</span>`
      : `${fmtClock(live || booked)}`);
  const plat = platformOf(s.locationMetadata);
  const op = (s.scheduleMetadata && s.scheduleMetadata.operator && s.scheduleMetadata.operator.name) || "";
  const uid = (s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity) || "";
  return `<button class="card" data-uid="${esc(uid)}" data-op="${esc(op)}">
    <div class="card-row"><span class="card-time">${timeHtml}</span>${pinStarHtml(uid, op, dest.name, fmtClock(live || booked))}</div>
    <div class="card-dest">${esc(dest.name)}</div>
    <div class="card-meta"><span class="op-name">${esc(op)}</span><span class="card-plat">${plat ? "Plat " + esc(plat) : "Plat —"}</span></div>
  </button>`;
}

// A tappable star for saving a train to the pinned shortlist, without
// triggering the card's own "lock onto this train" click (stopPropagation).
function pinStarHtml(uid, op, dest, time) {
  const on = isPinned(uid);
  return `<span class="pin-star${on ? " on" : ""}" data-pin-uid="${esc(uid)}" data-pin-op="${esc(op)}" ` +
    `data-pin-dest="${esc(dest)}" data-pin-time="${esc(time)}" title="${on ? "Unpin" : "Pin this train"}">${on ? "★" : "☆"}</span>`;
}
function bindPinStars() {
  $screen.querySelectorAll(".pin-star").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      togglePin({ uid: el.dataset.pinUid, op: el.dataset.pinOp, dest: el.dataset.pinDest, time: el.dataset.pinTime });
      const on = isPinned(el.dataset.pinUid);
      el.textContent = on ? "★" : "☆";
      el.classList.toggle("on", on);
      el.title = on ? "Unpin" : "Pin this train";
    };
  });
}

// ---------- STATE 2: moving, unidentified ----------
async function enterMoving() {
  clearNav();
  prunePins();
  current = State.MOVING;
  pinnedStation = null;
  candidates = []; candidateIdx = 0;
  setStatus("ON A TRAIN", "ok");
  renderNotice("ON THE MOVE", "Working out which train you're on…", true);

  const ahead = stationAhead(lastFix);
  if (!ahead) { renderNotice("CAN'T LOCATE", "No nearby stations found.", false, true); return; }

  try {
    const data = await api(`/api/board/${ahead.station.c}`);
    if (current !== State.MOVING) return;
    const prevServices = discovery.stationCrs === ahead.station.c ? discovery.services : null;
    const services = mergeBoardServices(data.services || [], prevServices);
    discovery = { stationCrs: ahead.station.c, services };
    candidates = rankByDirection(services, ahead.station);

    // Auto-lock when there's exactly one plausible train (the most QR-like feel).
    if (candidates.length === 1) {
      const s = candidates[0];
      const uid = s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity;
      const op = s.scheduleMetadata && s.scheduleMetadata.operator && s.scheduleMetadata.operator.name;
      if (uid) { lockOnto(uid, op, true); return; }
    }
    if (candidates.length) { candidateIdx = 0; renderGuess(); }
    else renderFallbackList(ahead.station, services);
  } catch (e) {
    renderNotice("CAN'T IDENTIFY TRAIN", e.message, false, true);
  }
}

// Rank departures so those heading our way come first (using destination name coords).
// RTT's per-service origin/destination entries only carry longCodes (TIPLOC), never
// shortCodes (CRS), so we match by station name against stations.json instead.
function rankByDirection(services, atStation) {
  const from = { y: atStation.y, x: atStation.x };
  return services
    .map((s) => {
      const name = destInfo(s).name;
      const dest = name ? nameIndex.get(name.toLowerCase()) : null;
      let score = 999;
      if (dest && bearing != null) score = angleDiff(bearingDeg(from, dest), bearing);
      return { s, score };
    })
    .filter((x) => bearing == null || x.score <= DIRECTION_TOLERANCE || x.score === 999)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.s);
}

function renderGuess() {
  const s = candidates[candidateIdx];
  const dep = s.temporalData && s.temporalData.departure;
  const dest = destInfo(s);
  const time = fmtClock(bestTime(dep));
  const op = (s.scheduleMetadata && s.scheduleMetadata.operator && s.scheduleMetadata.operator.name) || "";
  const uid = (s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity) || "";
  const remaining = candidates.length - candidateIdx - 1;
  $screen.innerHTML = `
    <div class="screen-title">Are you on this train?</div>
    <div class="guess-wrap">
      <div class="guess-card">
        <div class="card-row"><span class="card-time">${time}</span>${pinStarHtml(uid, op, dest.name, time)}</div>
        <div class="card-dest">${esc(dest.name)}</div>
        <div class="card-meta"><span class="op-name">${esc(op)}</span></div>
        <div class="candidate-count">${remaining > 0 ? remaining + " other option(s)" : "last option"}</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-yes" id="g-yes">✓ YES</button>
        <button class="btn btn-no" id="g-no">✗ NOT THIS ONE</button>
      </div>
    </div>
    <button class="link-btn" id="g-list">Show all departures instead</button>
    <button class="link-btn" id="g-nearby">Wrong station? Pick a nearby one</button>
    ${pinnedTrains.length ? `<button class="link-btn" id="g-pinned">⭐ Pinned trains (${pinnedTrains.length})</button>` : ""}`;
  document.getElementById("g-yes").onclick = () => lockOnto(uid, op, false, renderGuess);
  document.getElementById("g-no").onclick = nextCandidate;
  document.getElementById("g-list").onclick = () => {
    pushNav(renderGuess);
    renderFallbackList({ c: discovery.stationCrs, n: discovery.stationCrs }, discovery.services);
  };
  document.getElementById("g-nearby").onclick = () => { pushNav(renderGuess); renderNearbyStations(); };
  const gp = document.getElementById("g-pinned");
  if (gp) gp.onclick = () => { pushNav(renderGuess); renderPinned(); };
  bindPinStars();
}

function nextCandidate() {
  candidateIdx++;
  if (candidateIdx < candidates.length) renderGuess();
  else renderFallbackList({ c: discovery.stationCrs, n: discovery.stationCrs }, discovery.services || []);
}

function renderFallbackList(station, services) {
  const cards = (services || []).map(departureCard).join("")
    || `<div class="notice"><div class="big">No departures found</div></div>`;
  $screen.innerHTML =
    `<div class="screen-title">Tap the train you're on (${esc(station.c)})</div>${cards}` +
    `<div class="btn-row" style="margin-top:6px">
       <button class="btn" id="rescan">↻ RE-SCAN</button>
       <button class="btn" id="nearby">NEARBY STATIONS →</button>
     </div>` +
    (pinnedTrains.length ? `<button class="link-btn" id="pinned-link">⭐ Pinned trains (${pinnedTrains.length})</button>` : "");
  bindCards(() => renderFallbackList(station, services));
  document.getElementById("rescan").onclick = enterMoving;
  document.getElementById("nearby").onclick = () => { pushNav(() => renderFallbackList(station, services)); renderNearbyStations(); };
  const pl = document.getElementById("pinned-link");
  if (pl) pl.onclick = () => { pushNav(() => renderFallbackList(station, services)); renderPinned(); };
}

// ---------- STATE 3: confirmed ----------
function lockOnto(uid, op, auto, returnTo) {
  if (!uid) return;
  clearNav();
  prunePins();
  if (returnTo) pushNav(returnTo);
  locked = { uid, op: op || "", auto: !!auto };
  try { sessionStorage.setItem("mytrain.locked", JSON.stringify(locked)); } catch (_) {}
  // Make the URL a deep link to this exact train (shareable / bookmarkable / QR-able).
  try {
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", location.pathname + "?train=" + encodeURIComponent(uid));
    }
  } catch (_) {}
  current = State.CONFIRMED;
  setStatus("TRAIN LOCKED", "ok");
  stopGeo();              // no need to track location once we know the train
  lastSvc = null; lastLoadedAt = 0; staleMsg = "";   // fresh train, no stale fallback
  try { localStorage.removeItem("mytrain.lastSvc"); } catch (_) {}
  loadService();
  startAutoRefresh();
}

function shareTrain() {
  if (!locked) return;
  let url;
  try { url = location.origin + location.pathname + "?train=" + encodeURIComponent(locked.uid); } catch (_) { return; }
  if (navigator.share) { navigator.share({ title: "My Train", text: "Live train tracker", url }).catch(() => {}); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => setStatus("LINK COPIED", "ok"), () => window.prompt("Copy this link", url));
    return;
  }
  window.prompt("Copy this link", url);
}
function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (current === State.CONFIRMED) loadService(true); }, REFRESH_MS);
}
async function loadService(silent) {
  if (!locked) return;
  if (!lastSvc) {
    // Cold start (fresh reload): recover the last known timetable from disk
    // before trying the network, so an offline reload doesn't show a blank error.
    try {
      const cached = JSON.parse(localStorage.getItem("mytrain.lastSvc") || "null");
      if (cached && cached.uid === locked.uid) { lastSvc = cached.svc; lastLoadedAt = cached.at; }
    } catch (_) {}
  }
  if (!silent && !lastSvc) renderNotice("LOADING TRAIN", "Fetching live progress…", true);
  try {
    const data = await api(`/api/service?uid=${encodeURIComponent(locked.uid)}`);
    const svc = data.service || data;
    if (!svc || !svc.locations) throw new Error("No data");
    lastLoadedAt = Date.now();
    staleMsg = "";
    renderTrain(svc);
    try { localStorage.setItem("mytrain.lastSvc", JSON.stringify({ uid: locked.uid, at: lastLoadedAt, svc })); } catch (_) {}
  } catch (e) {
    if (lastSvc) {
      // Poor signal: keep showing the last good timetable rather than blanking it.
      staleMsg = (typeof navigator !== "undefined" && navigator.onLine === false)
        ? "Offline — showing last update" : "Couldn't refresh — showing last update";
      renderTrain(lastSvc);
    } else if (!silent) {
      renderNotice("CAN'T LOAD TRAIN", e.message, false, true, true);
    }
  }
}

function renderTrain(svc) {
  lastSvc = svc;
  const all = svc.locations || [];
  // Public calling points only (exclude PASS / CANCELLED / DIVERTED).
  const stops = all.filter((l) => {
    const da = l.temporalData && l.temporalData.displayAs;
    return da === "CALL" || da === "STARTS" || da === "TERMINATES";
  });
  if (!stops.length) { renderNotice("NO STOP DATA", "This service has no calling points to show.", false, true, true); return; }

  let lastDeparted = -1;
  stops.forEach((l, i) => {
    if (l.temporalData && l.temporalData.departure && l.temporalData.departure.realtimeActual) lastDeparted = i;
  });

  const finalIdx = stops.length - 1;
  const final = stops[finalIdx];
  const arrived = final.temporalData && final.temporalData.arrival && final.temporalData.arrival.realtimeActual;
  const nextIdx = arrived ? finalIdx : Math.min(lastDeparted + 1, finalIdx);
  const next = stops[nextIdx];

  const probeTd = (next.temporalData && (next.temporalData.arrival || next.temporalData.departure)) || null;
  const delayMin = latenessMin(probeTd);
  const reasons = svc.reasons && svc.reasons[0];
  const reason = reasons ? (reasons.longText || reasons.shortText || "") : "";

  const op = (svc.scheduleMetadata && svc.scheduleMetadata.operator && svc.scheduleMetadata.operator.name) || locked.op || "";
  const finalName = locName(final);
  const headcode = (svc.scheduleMetadata && (svc.scheduleMetadata.trainReportingIdentity || svc.scheduleMetadata.identity)) || "";

  // The origin's booked departure time — how this train is identified at
  // the station — paired with its current expected/live time.
  const originDep = stops[0].temporalData && stops[0].temporalData.departure;
  const originBooked = bookedTime(originDep);
  const originLive = bestTime(originDep);
  const originLate = originBooked && originLive && Math.abs(originBooked - originLive) >= 60000;
  const dueHtml = schedExpHtml(originBooked, originLive, originLate);

  // Where the train is right now.
  let posLine;
  if (arrived) {
    posLine = `Arrived at ${esc(finalName)}`;
  } else if (lastDeparted < 0) {
    posLine = `At ${esc(locName(stops[0]))} · departs ${fmtClock(bestTime(stops[0].temporalData && stops[0].temporalData.departure))}`;
  } else {
    const st = next.temporalData && next.temporalData.status;
    posLine = (st === "AT_PLATFORM" || st === "ARRIVING")
      ? `At ${esc(locName(next))}`
      : legProgressHtml(stops[lastDeparted], next);
  }

  let html = `<div class="train-head">
      <div>
        <div class="op">${esc(op)}${pinStarHtml(locked.uid, op, finalName, fmtClock(originLive || originBooked))}</div>
        <div class="due">${dueHtml}</div>
      </div>
      <div class="final">to ${esc(finalName)}${headcode ? `<br>${esc(headcode)}` : ""}</div>
    </div>`;

  if (locked.auto) html += `<div class="auto-note">Auto-picked your most likely train — wrong one? Use the button below.</div>`;

  if (arrived) {
    html += `<div class="delay-banner delay-ok">✓ ARRIVED AT ${esc(finalName).toUpperCase()}</div>`;
  } else {
    const bannerSev = delaySeverity(delayMin);
    const bannerIcon = severityIcon(bannerSev);
    const bannerLabel = bannerSev === "bad" ? `DELAYED ${delayMin} MIN` : bannerSev === "warn" ? `RUNNING ${delayMin} MIN LATE` : "ON TIME";
    html += `<div class="delay-banner delay-${bannerSev}">${bannerIcon} ${bannerLabel}${reason ? `<div class="delay-reason">${esc(reason)}</div>` : ""}</div>`;
  }

  html += `<div class="train-status">${posLine}</div>`;

  // A service with more than one top-level destination divides into separate
  // portions somewhere ahead (confirmed against a live RTT board response —
  // RTT signals this via multiple `destination` entries on the service itself,
  // not a separate "associations" field). Surface it as soon as it's known,
  // not just when the stop card scrolls into view, since the user needs to
  // know which part of the train to be in well in advance.
  const splitDests = (svc.destination || []).length > 1 ? svc.destination : null;
  const formationIdx = formationChangeIdx(stops, nextIdx);
  if (!arrived && splitDests) {
    const where = formationIdx >= 0 ? ` at ${esc(locName(stops[formationIdx]))}` : "";
    const parts = splitDests.map((d) => `${esc(d.location && d.location.description)} (${fmtClock(bestTime(d.temporalData))})`).join(" and ");
    html += `<div class="delay-banner delay-warn">⚡ This train divides${where} — portions go to ${parts}. Check which part you need.</div>`;
  }

  // "Your stop" banner (if the user has tapped a stop to track).
  const myCrs = locked.myStopCrs;
  if (myCrs) {
    const mi = stops.findIndex((s) => stopCrs(s) === myCrs);
    if (mi >= 0) {
      const myStop = stops[mi];
      const myEta = bestTime((myStop.temporalData && (myStop.temporalData.arrival || myStop.temporalData.departure)) || null);
      if (arrived || mi < nextIdx) {
        html += `<div class="yourstop done">Passed your stop (${esc(locName(myStop))}) · tap to clear</div>`;
      } else if (mi === nextIdx) {
        html += `<div class="yourstop now">GET OFF NEXT — ${esc(locName(myStop))} · ${etaText(myEta)}</div>`;
      } else {
        html += `<div class="yourstop">YOUR STOP — ${esc(locName(myStop))} · ${etaText(myEta)} (${fmtClock(myEta)})</div>`;
      }
    }
  } else if (!arrived) {
    html += `<div class="hint-tap">Tap a stop below to track when to get off.</div>`;
  }

  if (!arrived) {
    if (nextIdx === finalIdx) {
      html += stopBlock("FINAL DESTINATION", final, true, myCrs, nextIdx === formationIdx);
    } else {
      html += stopBlock("NEXT STOP", next, false, myCrs, nextIdx === formationIdx);
      html += `<div class="screen-title" style="margin-top:6px">Then calling at</div>`;
      for (let i = nextIdx + 1; i <= finalIdx; i++) html += stopRow(stops[i], i === finalIdx, myCrs, i === formationIdx);
    }
  }

  html += `<button class="btn btn-wide refresh-btn" id="refresh-now">↻ REFRESH</button>`;
  const ago = lastLoadedAt ? Math.round((Date.now() - lastLoadedAt) / 60000) : 0;
  const agoTxt = !lastLoadedAt ? "now" : (ago <= 0 ? "just now" : `${ago} min ago`);
  html += `<div class="updated-note${staleMsg ? " warn" : ""}">${staleMsg ? esc(staleMsg) + " · " : "Updated "}${staleMsg ? "" : agoTxt + " · "}auto-refresh 60s</div>`;
  html += `<button class="btn btn-wide" id="qr" style="margin-top:8px">▦ SHARE / QR</button>`;
  html += `<button class="btn btn-wide" id="forget" style="margin-top:10px">DIFFERENT TRAIN</button>`;
  if (pinnedTrains.length) html += `<button class="link-btn" id="pinned-link">⭐ Pinned trains (${pinnedTrains.length})</button>`;
  html += `<div class="app-footer">
    Made by <a href="https://www.strangegoose.co.uk" target="_blank" rel="noopener">Strange Goose</a><br>
    Train data via <a href="https://www.realtimetrains.co.uk" target="_blank" rel="noopener">Realtime Trains</a>
    ${apiLimitFooterHtml()}
  </div>`;

  $screen.innerHTML = html;
  document.getElementById("refresh-now").onclick = () => loadService(false);
  document.getElementById("forget").onclick = forgetTrain;
  const qr = document.getElementById("qr");
  if (qr) qr.onclick = () => { pushNav(() => renderTrain(svc)); renderQR(); };
  const pl = document.getElementById("pinned-link");
  if (pl) pl.onclick = () => { pushNav(() => renderTrain(svc)); renderPinned(); };
  // Tap a stop to mark it as "my stop" (tap again to clear).
  $screen.querySelectorAll("[data-crs]").forEach((el) => {
    el.onclick = () => setMyStop(el.getAttribute("data-crs"));
  });
  const ys = $screen.querySelector(".yourstop");
  if (ys) ys.onclick = () => setMyStop(locked.myStopCrs);
  bindPinStars();
}

function stopCrs(stop) {
  return (stop.location && stop.location.shortCodes && stop.location.shortCodes[0]) || "";
}

function setMyStop(crs) {
  if (!locked) return;
  locked.myStopCrs = (locked.myStopCrs === crs) ? undefined : crs; // toggle
  try { sessionStorage.setItem("mytrain.locked", JSON.stringify(locked)); } catch (_) {}
  if (lastSvc) renderTrain(lastSvc);
}

// Render a scannable QR of the deep link, so someone can point a camera at your
// screen and open the same live train view — the same idea as on-train QR codes.
function renderQR() {
  if (!locked) return;
  let url;
  try { url = location.origin + location.pathname + "?train=" + encodeURIComponent(locked.uid); }
  catch (_) { url = "?train=" + encodeURIComponent(locked.uid); }
  let svg = "";
  try {
    if (window.qrcode) {
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }
  } catch (_) {}
  $screen.innerHTML = `<div class="notice">
    <div class="screen-title">Scan to open this train</div>
    ${svg ? `<div class="qr-box">${svg}</div>` : `<div class="sub">Couldn't draw a QR here — use Share instead.</div>`}
    <div class="sub">Point a phone camera at this to open the same live timetable.</div>
    <button class="btn btn-wide" id="qr-share">🔗 SHARE LINK</button>
  </div>`;
  const s = document.getElementById("qr-share");
  if (s) s.onclick = shareTrain;
}

function locName(stop) {
  return (stop.location && (stop.location.description || (stop.location.shortCodes && stop.location.shortCodes[0]))) || "—";
}

// Short label for the progress bar: the 3-letter CRS if we have one,
// else the first 3 letters of the name — keeps both ends on one line.
function shortCode(stop) {
  return (stopCrs(stop) || locName(stop).slice(0, 3)).toUpperCase();
}

// "Left A, heading to B" rendered as a track with a train icon positioned
// by elapsed time between A's departure and B's best arrival/departure time,
// instead of just naming both ends.
function legProgressHtml(from, to) {
  const dep = bestTime(from.temporalData && from.temporalData.departure);
  const arr = bestTime((to.temporalData && (to.temporalData.arrival || to.temporalData.departure)) || null);
  let pct = 50;
  if (dep && arr && arr > dep) {
    pct = ((Date.now() - dep.getTime()) / (arr.getTime() - dep.getTime())) * 100;
    pct = Math.max(4, Math.min(96, pct));
  }
  return `<div class="train-progress">
      <span class="tp-code">${esc(shortCode(from))}</span>
      <div class="tp-track"><div class="tp-fill" style="width:${pct}%"></div><span class="tp-train" style="left:${pct}%">🚆</span></div>
      <span class="tp-code">${esc(shortCode(to))}</span>
    </div>`;
}

// Each calling point can carry locationMetadata.numberOfVehicles (confirmed
// against a live RTT board response) — the stop where that count changes is
// where the train divides or joins, pinpointing the banner's general "ahead
// somewhere" notice to one exact stop. Scans from `fromIdx` onward only —
// an earlier vehicle-count change (e.g. portions joined before the user even
// boarded) is history, not the upcoming split we're warning about.
function formationChangeIdx(stops, fromIdx) {
  const baseline = stops[fromIdx - 1] && stops[fromIdx - 1].locationMetadata;
  let prev = baseline ? baseline.numberOfVehicles : null;
  for (let i = fromIdx; i < stops.length; i++) {
    const n = stops[i].locationMetadata && stops[i].locationMetadata.numberOfVehicles;
    if (n == null) continue;
    if (prev != null && n !== prev) return i;
    prev = n;
  }
  return -1;
}

function splitJoinBadgeHtml(stop, isFormationChange) {
  if (!isFormationChange) return "";
  return `<div class="split-note">⚡ Train divides/joins here — check which part you need</div>`;
}

// Labelled scheduled/expected pair, shared by stopBlock and stopRow so the
// two times are never ambiguous about which is which. Severity (color +
// icon) scales with how late, so the badge isn't a color-only signal.
function schedExpHtml(booked, arr, showBoth) {
  if (!showBoth) return `${fmtClock(booked || arr)}`;
  const min = booked && arr ? Math.round((arr - booked) / 60000) : 0;
  const sev = delaySeverity(min);
  return `<span class="time-label">SCH</span> <span class="strike">${fmtClock(booked)}</span> ` +
    `<span class="time-label ${sev}">EXP</span> <span class="${severityBadgeClass(sev)}">${severityIcon(sev)} ${fmtClock(arr)}</span>`;
}

function stopBlock(label, stop, isFinal, myCrs, isFormationChange) {
  const td = stop.temporalData || {};
  const tdArr = td.arrival || td.departure;       // intermediate/destination use arrival; origin uses departure
  const arr = bestTime(tdArr);
  const booked = bookedTime(tdArr);
  const plat = platformOf(stop.locationMetadata);
  const showBoth = booked && arr && Math.abs(booked - arr) >= 60000;
  const crs = stopCrs(stop);
  const mine = crs && crs === myCrs ? " mine" : "";
  return `<div class="stop${isFinal ? " final" : ""}${mine}" data-crs="${esc(crs)}">
    <div class="stop-label">${label}${mine ? " · YOUR STOP" : ""}</div>
    <div class="stop-name">${esc(locName(stop))}</div>
    <div class="stop-bottom">
      <span class="stop-eta">${etaText(arr)}</span>
      <span class="stop-time">${schedExpHtml(booked, arr, showBoth)}</span>
    </div>
    ${plat ? `<div class="stop-plat">Plat ${esc(plat)}</div>` : ""}
    ${splitJoinBadgeHtml(stop, isFormationChange)}
  </div>`;
}

// Compact one-line row for each remaining calling point in the full timetable.
function stopRow(stop, isFinal, myCrs, isFormationChange) {
  const td = stop.temporalData || {};
  const tdArr = td.arrival || td.departure;
  const arr = bestTime(tdArr);
  const booked = bookedTime(tdArr);
  const showBoth = booked && arr && Math.abs(booked - arr) >= 60000;
  const plat = platformOf(stop.locationMetadata);
  const crs = stopCrs(stop);
  const mine = crs && crs === myCrs ? " mine" : "";
  return `<div class="stoprow${isFinal ? " final" : ""}${mine}" data-crs="${esc(crs)}">
    <span class="sr-name">${esc(locName(stop))}${isFinal ? ` <span class="sr-dest">DEST</span>` : ""}${mine ? ` <span class="sr-dest">YOUR STOP</span>` : ""}</span>
    <span class="sr-right">
      <span class="sr-eta">${etaText(arr)}</span>
      <span class="sr-time">${schedExpHtml(booked, arr, showBoth)}${plat ? ` · P${esc(plat)}` : ""}</span>
    </span>
    ${splitJoinBadgeHtml(stop, isFormationChange)}
  </div>`;
}

function forgetTrain() {
  clearNav();
  prunePins();
  clearInterval(refreshTimer);
  locked = null;
  try { sessionStorage.removeItem("mytrain.locked"); } catch (_) {}
  try { if (typeof history !== "undefined" && history.replaceState) history.replaceState(null, "", location.pathname); } catch (_) {}
  current = State.ACQUIRING;
  lastFix = null;
  fixHistory = [];
  lastSvc = null; lastLoadedAt = 0; staleMsg = "";
  pinnedStation = null;
  setStatus("LOCATING", "");
  renderNotice("FINDING YOU", "Re-checking your location…", true, false, false, true);
  startGeo();   // resume GPS to pick the next train
  armAcquiringNudge();
}

// ---------- rendering primitives ----------
function renderNotice(big, sub, spinner, isError, allowForget, allowPinned) {
  $screen.innerHTML = `<div class="notice">
    ${spinner ? `<div class="spinner"></div>` : ""}
    <div class="big">${esc(big)}</div>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
    ${isError ? `<button class="btn btn-wide" id="retry">↻ TRY AGAIN</button>` : ""}
    ${allowForget ? `<button class="link-btn" id="forget2">Pick a different train</button>` : ""}
    ${allowPinned && pinnedTrains.length ? `<button class="link-btn" id="pinned-link">⭐ Pinned trains (${pinnedTrains.length})</button>` : ""}
  </div>`;
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = () => {
    if (current === State.CONFIRMED) return loadService(false);
    current = State.ACQUIRING;
    if (!lastFix) { startGeo(); armAcquiringNudge(); }
    evaluate();
  };
  const f2 = document.getElementById("forget2");
  if (f2) f2.onclick = forgetTrain;
  const pl = document.getElementById("pinned-link");
  if (pl) pl.onclick = () => { pushNav(() => renderNotice(big, sub, spinner, isError, allowForget, allowPinned)); renderPinned(); };
}
function refreshButton(label, id) { return `<button class="btn btn-wide" id="${id}">↻ ${esc(label)}</button>`; }
function bindCards(returnTo) {
  $screen.querySelectorAll(".card").forEach((el) => {
    el.onclick = () => lockOnto(el.dataset.uid, el.dataset.op, false, returnTo);
  });
  bindPinStars();
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- guide ----------
// A short "how it works" overlay for new users (auto-shown once) and
// returning users (reachable any time via the "?" button). It's appended
// to <body> rather than rendered into #screen, so it floats above whatever
// screen is currently showing without disturbing app state underneath.
const GUIDE_STEPS = [
  "No typing — just allow location and the app does the rest.",
  "<b>At a station:</b> tap the train you're on from the live departures, then pin it (★).",
  "<b>Locked on:</b> see every remaining stop with live times, platforms and delays, auto-refreshing every 60s.",
  "Tap a stop to get a reminder banner when it's time to get off.",
  "Pin a train (★), or share it as a QR code / link — both work from the train screen.",
  "<b>Between stations:</b> the app waits for the next station's board rather than guessing — \"Lost your train?\" is there if you really can't wait.",
];
function showGuide() {
  const html = `<div class="guide-overlay" id="guide-overlay">
    <div class="guide-card">
      <h2>How My Train works</h2>
      ${GUIDE_STEPS.map((s, i) => `<div class="guide-step"><span class="num">${i + 1}</span><span class="txt">${s}</span></div>`).join("")}
      <button class="btn btn-wide" id="guide-ok">GOT IT</button>
    </div>
  </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  const overlay = document.getElementById("guide-overlay");
  document.getElementById("guide-ok").onclick = hideGuide;
  overlay.onclick = (e) => { if (e.target === overlay) hideGuide(); };
}
function hideGuide() {
  const overlay = document.getElementById("guide-overlay");
  if (overlay) overlay.remove();
}
if ($helpBtn) $helpBtn.onclick = showGuide;

// ---------- boot ----------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  try {
    if (!localStorage.getItem("mytrain.seenGuide")) {
      localStorage.setItem("mytrain.seenGuide", "1");
      showGuide();
    }
  } catch (_) {}

  let deepUid = null;
  try { deepUid = new URLSearchParams(location.search).get("train"); } catch (_) {}
  const saved = sessionStorage.getItem("mytrain.locked");

  if (deepUid) {
    // Deep link / QR target: go straight into this exact train's timetable.
    lockOnto(deepUid, "", false);
  } else if (saved) {
    try {
      locked = JSON.parse(saved);
      current = State.CONFIRMED;
      setStatus("TRAIN LOCKED", "ok");
      loadService();
      startAutoRefresh();
    } catch (_) { sessionStorage.removeItem("mytrain.locked"); }
  } else if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // No point waiting on GPS/live boards with no signal — go straight to
    // whatever's already saved locally.
    showOfflineFallback();
  } else {
    setStatus("STARTING", "");
    renderNotice("GETTING GPS", "Allow location to find your train.", true, false, false, true);
  }

  // Fetch the station list in parallel with GPS acquisition below — on a slow
  // connection this can take a while, and there's no reason to make the user
  // wait on it before we even ask for a location fix.
  fetch("stations.json")
    .then((res) => res.json())
    .then((list) => {
      stations = list;
      crsIndex = new Map(stations.map((s) => [s.c, { y: s.y, x: s.x }]));
      nameIndex = new Map(stations.map((s) => [s.n.toLowerCase(), { y: s.y, x: s.x }]));
    })
    .catch(() => {
      if (current !== State.CONFIRMED && current !== State.IDLE) {
        renderNotice("LOAD ERROR", "Couldn't load station data. Reload the app.", false, true);
      }
    });

  // If we opened straight into a locked train (deep link / saved), don't start GPS.
  if (current === State.CONFIRMED) return;

  if (!navigator.geolocation) {
    renderNotice("NO GPS", "This device has no geolocation support.", false, false, false, true);
    return;
  }
  startGeo();
  armAcquiringNudge();
}

// If no fix and no error after a while, nudge the user about permissions/signal
// instead of leaving them on a bare spinner with no way out. Needed anywhere
// we drop back into State.ACQUIRING, not just on initial boot — re-acquiring a
// fix (e.g. after forgetting a train) can be just as slow as the first one.
function armAcquiringNudge() {
  setTimeout(() => {
    if (!lastFix && current === State.ACQUIRING) {
      renderNotice("STILL FINDING YOU",
        "Check that location is allowed for this site (tap the icon left of the address) and that battery saver is off. Being near a window helps.",
        true, true, false, true);
    }
  }, 15000);
}

boot();
