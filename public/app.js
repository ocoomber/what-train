/* My Train — vanilla JS PWA.
 *
 * Fires GPS on load (no buttons) and resolves into one of three states:
 *   1. AT A STATION  -> tappable live departures
 *   2. ON A TRAIN, UNIDENTIFIED -> best-guess card (YES / NOT THIS ONE), then fallback list
 *   3. TRAIN CONFIRMED -> next stop / stop after / destination ETAs, auto-refresh 60s
 */

"use strict";

const API_BASE = (window.MYTRAIN_CONFIG && window.MYTRAIN_CONFIG.API_BASE || "").replace(/\/$/, "");

// Thresholds
const STOPPED_MPH = 3;      // at/near zero
const MOVING_MPH = 30;      // confidently on a moving train
const STATION_RADIUS_M = 300;
const DIRECTION_TOLERANCE = 70; // deg; for "ahead" / direction-match scoring
const REFRESH_MS = 60000;

// ---- app state ----
const State = { ACQUIRING: "ACQUIRING", STATION: "STATION", MOVING: "MOVING", CONFIRMED: "CONFIRMED" };
let current = State.ACQUIRING;

let stations = [];          // [{c,n,y,x}]
let nameIndex = new Map();  // normalized name -> {y,x}
let lastFix = null;         // last good position
let speedMph = 0;
let bearing = null;         // degrees 0..360, or null

let discovery = { stationCrs: null, services: null };  // cached board for current discovery
let candidates = [];        // state-2 ordered guesses
let candidateIdx = 0;

let locked = null;          // {uid, runDate, atocName}
let refreshTimer = null;

const $screen = document.getElementById("screen");
const $statusText = document.getElementById("status-text");
const $statusDot = document.getElementById("status-dot");
const $speed = document.getElementById("speed-readout");

// ---------- geo helpers ----------
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.y - a.y);
  const dLon = toRad(b.x - a.x);
  const lat1 = toRad(a.y), lat2 = toRad(b.y);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(a, b) {
  const lat1 = toRad(a.y), lat2 = toRad(b.y);
  const dLon = toRad(b.x - a.x);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function geocodeName(desc) {
  const exact = nameIndex.get(normName(desc));
  if (exact) return exact;
  // RTT descriptions sometimes drop/add prefixes; try a few loosened forms.
  const n = normName(desc);
  for (const [k, v] of nameIndex) {
    if (k === n || k.endsWith(n) || n.endsWith(k)) return v;
  }
  return null;
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

// Nearest station that lies ahead of us along the current bearing (fallback: nearest overall).
function stationAhead(pos) {
  if (bearing == null) return nearestStation(pos);
  let best = null, bestD = Infinity;
  for (const s of stations) {
    const d = distanceM(pos, s);
    if (d < 150 || d > 30000) continue; // skip the one we're basically at, and far ones
    if (angleDiff(bearingDeg(pos, s), bearing) <= DIRECTION_TOLERANCE && d < bestD) {
      bestD = d; best = s;
    }
  }
  return best ? { station: best, distance: bestD } : nearestStation(pos);
}

// ---------- status bar ----------
function setStatus(text, kind) {
  $statusText.textContent = text;
  $statusDot.className = "dot" + (kind ? " " + kind : "");
}
function updateSpeedReadout() {
  if (lastFix) {
    const b = bearing == null ? "" : " " + compass(bearing);
    $speed.textContent = `${Math.round(speedMph)} mph${b}`;
  }
}
function compass(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

// ---------- time helpers ----------
function parseHHMM(hhmm, base) {
  if (!hhmm || hhmm.length < 4) return null;
  const d = new Date(base);
  d.setHours(parseInt(hhmm.slice(0, 2), 10), parseInt(hhmm.slice(2, 4), 10), 0, 0);
  return d;
}
function fmtHHMM(hhmm) {
  return hhmm && hhmm.length >= 4 ? `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}` : "--:--";
}
function minsFromNow(date) {
  return Math.round((date.getTime() - Date.now()) / 60000);
}
function etaText(date) {
  if (!date) return "";
  const m = minsFromNow(date);
  if (m <= 0) return "DUE";
  if (m === 1) return "1 MIN";
  if (m > 180) return fmtHHMM2(date);
  return `${m} MIN`;
}
function fmtHHMM2(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- RTT API ----------
async function api(path) {
  if (!API_BASE || API_BASE.includes("example.workers.dev")) {
    throw new Error("API not configured. Set API_BASE in config.js to your Worker URL.");
  }
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let msg = `Service error (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

const todayParts = () => {
  const d = new Date();
  return {
    Y: d.getFullYear(),
    M: String(d.getMonth() + 1).padStart(2, "0"),
    D: String(d.getDate()).padStart(2, "0"),
  };
};

// ---------- main GPS loop ----------
function onPosition(pos) {
  const c = pos.coords;
  const fix = { y: c.latitude, x: c.longitude, t: pos.timestamp };

  // speed: prefer device-reported (m/s), else derive from consecutive fixes
  let mps = (typeof c.speed === "number" && c.speed >= 0) ? c.speed : null;
  if (mps == null && lastFix) {
    const dt = (fix.t - lastFix.t) / 1000;
    if (dt > 0) mps = distanceM(lastFix, fix) / dt;
  }
  if (mps != null) speedMph = mps * 2.23694;

  // bearing: prefer device heading when moving, else derive
  if (typeof c.heading === "number" && !isNaN(c.heading) && speedMph > STOPPED_MPH) {
    bearing = c.heading;
  } else if (lastFix && distanceM(lastFix, fix) > 8) {
    bearing = bearingDeg(lastFix, fix);
  }

  lastFix = fix;
  updateSpeedReadout();
  evaluate();
}

function onPositionError(err) {
  if (current === State.CONFIRMED) return; // keep showing the locked train
  if (err.code === err.PERMISSION_DENIED) {
    setStatus("NO GPS", "err");
    renderNotice("LOCATION BLOCKED", "Allow location access for this site, then reload. My Train needs GPS to find your train.", false);
  } else {
    setStatus("GPS ERROR", "err");
    renderNotice("WAITING FOR GPS", "Couldn't get a location fix. Move near a window if you can.", true);
  }
}

// Decide which state we should be in (discovery states only; CONFIRMED is sticky).
function evaluate() {
  if (current === State.CONFIRMED) return;
  if (!lastFix) return;

  if (speedMph >= MOVING_MPH) {
    if (current !== State.MOVING) enterMoving();
    return;
  }

  if (speedMph <= STOPPED_MPH) {
    const near = nearestStation(lastFix, STATION_RADIUS_M);
    if (near) {
      if (current !== State.STATION || discovery.stationCrs !== near.station.c) {
        enterStation(near.station);
      }
      return;
    }
  }

  // In-between speed, or stopped but not at a station: hold a discovery screen if we have one.
  if (current === State.ACQUIRING) {
    setStatus("LOCATING", "");
    renderNotice("FINDING YOU", "Waiting for a clearer GPS fix…", true);
  }
}

// ---------- STATE 1: at a station ----------
async function enterStation(station) {
  current = State.STATION;
  discovery = { stationCrs: station.c, services: null };
  setStatus(`${station.c} STATION`, "ok");
  renderNotice(station.n.toUpperCase(), "Loading live departures…", true);
  try {
    const data = await api(`/api/board/${station.c}`);
    if (current !== State.STATION || discovery.stationCrs !== station.c) return;
    discovery.services = (data.services || []).filter((s) => s.locationDetail);
    renderStation(station, discovery.services);
  } catch (e) {
    renderNotice("CAN'T LOAD DEPARTURES", e.message, false, true);
  }
}

function renderStation(station, services) {
  const cards = services.length
    ? services.map((s) => departureCard(s)).join("")
    : `<div class="notice"><div class="big">No departures listed</div></div>`;
  $screen.innerHTML =
    `<div class="screen-title">${esc(station.n)} · departures</div>${cards}` +
    refreshLink("Reload departures", "reload-board");
  bindCards();
  document.getElementById("reload-board").onclick = () => enterStation(station);
}

function departureCard(s) {
  const ld = s.locationDetail;
  const dest = (ld.destination && ld.destination[0] && ld.destination[0].description) || "—";
  const booked = ld.gbttBookedDeparture;
  const rt = ld.realtimeDeparture;
  const late = booked && rt && booked !== rt;
  const timeHtml = late
    ? `<span class="strike">${fmtHHMM(booked)}</span> <span class="badge-late">${fmtHHMM(rt)}</span>`
    : `${fmtHHMM(booked || rt)}`;
  const plat = ld.platform ? `Plat ${esc(ld.platform)}` : "Plat —";
  const op = s.atocName || s.atocCode || "";
  return `<button class="card" data-uid="${esc(s.serviceUid)}" data-rundate="${esc(s.runDate || "")}" data-op="${esc(op)}">
    <div class="card-row"><span class="card-time">${timeHtml}</span></div>
    <div class="card-dest">${esc(dest)}</div>
    <div class="card-meta"><span>${esc(op)}</span><span class="card-plat">${plat}</span></div>
  </button>`;
}

// ---------- STATE 2: moving, unidentified ----------
async function enterMoving() {
  current = State.MOVING;
  candidates = []; candidateIdx = 0;
  setStatus("ON A TRAIN", "ok");
  renderNotice("ON THE MOVE", "Working out which train you're on…", true);

  const ahead = stationAhead(lastFix);
  if (!ahead) { renderNotice("CAN'T LOCATE", "No nearby stations found.", false, true); return; }

  try {
    const data = await api(`/api/board/${ahead.station.c}`);
    if (current !== State.MOVING) return;
    const services = (data.services || []).filter((s) => s.locationDetail);
    candidates = rankByDirection(services, ahead.station);
    discovery = { stationCrs: ahead.station.c, services }; // for fallback list
    if (candidates.length) {
      candidateIdx = 0;
      renderGuess();
    } else {
      renderFallbackList(ahead.station, services);
    }
  } catch (e) {
    renderNotice("CAN'T IDENTIFY TRAIN", e.message, false, true);
  }
}

// Score departures: those heading in our direction of travel first.
function rankByDirection(services, atStation) {
  const from = { y: atStation.y, x: atStation.x };
  return services
    .map((s) => {
      const destDesc = s.locationDetail.destination && s.locationDetail.destination[0]
        && s.locationDetail.destination[0].description;
      const dest = geocodeName(destDesc);
      let score = 999;
      if (dest && bearing != null) score = angleDiff(bearingDeg(from, dest), bearing);
      return { s, score };
    })
    // keep direction matches (or everything if we have no bearing to filter on)
    .filter((x) => bearing == null || x.score <= DIRECTION_TOLERANCE || x.score === 999)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.s);
}

function renderGuess() {
  const s = candidates[candidateIdx];
  const ld = s.locationDetail;
  const dest = (ld.destination && ld.destination[0] && ld.destination[0].description) || "—";
  const time = fmtHHMM(ld.realtimeDeparture || ld.gbttBookedDeparture);
  const op = s.atocName || s.atocCode || "";
  const remaining = candidates.length - candidateIdx - 1;
  $screen.innerHTML = `
    <div class="screen-title">Are you on this train?</div>
    <div class="guess-wrap">
      <div class="guess-card">
        <div class="card-row"><span class="card-time">${time}</span></div>
        <div class="card-dest">${esc(dest)}</div>
        <div class="card-meta"><span>${esc(op)}</span></div>
        <div class="candidate-count">${remaining > 0 ? remaining + " other option(s)" : "last option"}</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-yes" id="g-yes">✓ YES</button>
        <button class="btn btn-no" id="g-no">✗ NOT THIS ONE</button>
      </div>
    </div>` +
    `<button class="link-btn" id="g-list">Show all departures instead</button>`;

  document.getElementById("g-yes").onclick = () =>
    lockOnto(s.serviceUid, s.runDate, op);
  document.getElementById("g-no").onclick = nextCandidate;
  document.getElementById("g-list").onclick = () =>
    renderFallbackList({ c: discovery.stationCrs, n: discovery.stationCrs }, discovery.services);
}

function nextCandidate() {
  candidateIdx++;
  if (candidateIdx < candidates.length) {
    renderGuess();
  } else {
    renderFallbackList({ c: discovery.stationCrs, n: discovery.stationCrs }, discovery.services || []);
  }
}

function renderFallbackList(station, services) {
  const cards = (services || []).map((s) => departureCard(s)).join("")
    || `<div class="notice"><div class="big">No departures found</div></div>`;
  $screen.innerHTML =
    `<div class="screen-title">Tap the train you're on (${esc(station.c)})</div>${cards}` +
    refreshLink("Re-scan", "rescan");
  bindCards();
  document.getElementById("rescan").onclick = enterMoving;
}

// ---------- STATE 3: confirmed ----------
function lockOnto(uid, runDate, atocName) {
  locked = { uid, runDate: runDate || rundateToday(), atocName: atocName || "" };
  sessionStorage.setItem("mytrain.locked", JSON.stringify(locked));
  current = State.CONFIRMED;
  setStatus("TRAIN LOCKED", "ok");
  loadService();
  startAutoRefresh();
}
function rundateToday() {
  const t = todayParts();
  return `${t.Y}-${t.M}-${t.D}`;
}

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (current === State.CONFIRMED) loadService(true); }, REFRESH_MS);
}

async function loadService(silent) {
  if (!locked) return;
  const [Y, M, D] = locked.runDate.split("-");
  if (!silent) renderNotice("LOADING TRAIN", "Fetching live progress…", true);
  try {
    const data = await api(`/api/service/${locked.uid}/${Y}/${M}/${D}`);
    renderTrain(data);
  } catch (e) {
    if (!silent) renderNotice("CAN'T LOAD TRAIN", e.message, false, true, true);
  }
}

function renderTrain(svc) {
  const base = svc.runDate ? new Date(svc.runDate + "T00:00:00") : new Date();
  const stops = (svc.locations || []).filter((l) => l.displayAs !== "PASS" && (l.crs || l.description));

  // most recent stop we've actually departed
  let lastDeparted = -1;
  stops.forEach((l, i) => { if (l.realtimeDepartureActual) lastDeparted = i; });

  const finalIdx = stops.length - 1;
  const final = stops[finalIdx];
  const arrived = final && final.realtimeArrivalActual;

  const nextIdx = arrived ? -1 : Math.min(lastDeparted + 1, finalIdx);
  const next = nextIdx >= 0 ? stops[nextIdx] : null;
  const after = nextIdx >= 0 && nextIdx + 1 <= finalIdx && nextIdx + 1 !== finalIdx ? stops[nextIdx + 1] : null;

  // delay computed at the next stop (or destination if arrived)
  const probe = next || final;
  const delayMin = delayAt(probe, base);
  const reason = svc.cancelReason && svc.cancelReason.longText
    || svc.lateReason && svc.lateReason.longText || "";

  const op = svc.atocName || locked.atocName || "";
  const finalName = final ? (final.description || final.crs) : "—";

  let html = `<div class="train-head">
      <div class="op">${esc(op)}</div>
      <div class="final">to ${esc(finalName)}<br>${svc.trainIdentity ? esc(svc.trainIdentity) : ""}</div>
    </div>`;

  if (arrived) {
    html += `<div class="delay-banner delay-ok">ARRIVED AT ${esc(finalName).toUpperCase()}</div>`;
  } else if (delayMin >= 2) {
    html += `<div class="delay-banner delay-bad">DELAYED ${delayMin} MIN${reason ? `<div class="delay-reason">${esc(reason)}</div>` : ""}</div>`;
  } else {
    html += `<div class="delay-banner delay-ok">ON TIME${reason ? `<div class="delay-reason">${esc(reason)}</div>` : ""}</div>`;
  }

  if (!arrived && next) {
    html += stopBlock("NEXT STOP", next, base);
    if (after) html += stopBlock("THEN", after, base);
    if (final && final !== next && final !== after) html += stopBlock("FINAL DESTINATION", final, base, true);
  }

  html += `<button class="btn btn-wide refresh-btn" id="refresh-now">↻ REFRESH</button>`;
  html += `<div class="updated-note">Updated ${fmtHHMM2(new Date())} · auto-refresh 60s</div>`;
  html += `<button class="link-btn" id="forget">Not this train? Start over</button>`;

  $screen.innerHTML = html;
  document.getElementById("refresh-now").onclick = () => loadService(false);
  document.getElementById("forget").onclick = forgetTrain;
}

function stopBlock(label, stop, base, isFinal) {
  const arr = stop.realtimeArrival || stop.gbttBookedArrival || stop.realtimeDeparture || stop.gbttBookedDeparture;
  const booked = stop.gbttBookedArrival || stop.gbttBookedDeparture;
  const eta = parseHHMM(arr, base);
  const plat = stop.platform ? `Plat ${esc(stop.platform)}` : "";
  return `<div class="stop${isFinal ? " final" : ""}">
    <div class="stop-label">${label}</div>
    <div class="stop-name">${esc(stop.description || stop.crs)}</div>
    <div class="stop-bottom">
      <span class="stop-eta">${eta ? etaText(eta) : ""}</span>
      <span class="stop-time">${fmtHHMM(arr)}${booked && booked !== arr ? ` <span class="strike">${fmtHHMM(booked)}</span>` : ""}</span>
    </div>
    ${plat ? `<div class="stop-plat">${plat}</div>` : ""}
  </div>`;
}

function delayAt(stop, base) {
  if (!stop) return 0;
  const booked = stop.gbttBookedArrival || stop.gbttBookedDeparture;
  const rt = stop.realtimeArrival || stop.realtimeDeparture;
  const b = parseHHMM(booked, base), r = parseHHMM(rt, base);
  if (!b || !r) return 0;
  return Math.round((r - b) / 60000);
}

function forgetTrain() {
  clearInterval(refreshTimer);
  locked = null;
  sessionStorage.removeItem("mytrain.locked");
  current = State.ACQUIRING;
  setStatus("LOCATING", "");
  renderNotice("FINDING YOU", "Re-checking your location…", true);
  evaluate();
}

// ---------- rendering primitives ----------
function renderNotice(big, sub, spinner, isError, allowForget) {
  $screen.innerHTML = `<div class="notice">
    ${spinner ? `<div class="spinner"></div>` : ""}
    <div class="big">${esc(big)}</div>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
    ${isError ? `<button class="btn btn-wide" id="retry">↻ TRY AGAIN</button>` : ""}
    ${allowForget ? `<button class="link-btn" id="forget2">Pick a different train</button>` : ""}
  </div>`;
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = () => (current === State.CONFIRMED ? loadService(false) : (current = State.ACQUIRING, evaluate()));
  const f2 = document.getElementById("forget2");
  if (f2) f2.onclick = forgetTrain;
}

function refreshLink(label, id) {
  return `<button class="btn btn-wide" id="${id}">↻ ${esc(label)}</button>`;
}

function bindCards() {
  $screen.querySelectorAll(".card").forEach((el) => {
    el.onclick = () => lockOnto(el.dataset.uid, el.dataset.rundate, el.dataset.op);
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- boot ----------
async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Restore a locked train across reloads / signal dropouts.
  const saved = sessionStorage.getItem("mytrain.locked");
  if (saved) {
    try {
      locked = JSON.parse(saved);
      current = State.CONFIRMED;
      setStatus("TRAIN LOCKED", "ok");
      loadService();
      startAutoRefresh();
    } catch (_) { sessionStorage.removeItem("mytrain.locked"); }
  } else {
    setStatus("STARTING", "");
    renderNotice("GETTING GPS", "Allow location to find your train.", true);
  }

  try {
    const res = await fetch("stations.json");
    stations = await res.json();
    nameIndex = new Map(stations.map((s) => [normName(s.n), { y: s.y, x: s.x }]));
  } catch (_) {
    if (current !== State.CONFIRMED) renderNotice("LOAD ERROR", "Couldn't load station data. Reload the app.", false, true);
  }

  if (!navigator.geolocation) {
    if (current !== State.CONFIRMED) renderNotice("NO GPS", "This device has no geolocation support.", false);
    return;
  }
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
}

boot();
