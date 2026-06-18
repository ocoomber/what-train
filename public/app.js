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
 *   - destination[].location.shortCodes[0] gives the destination CRS, used for direction.
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
let idleCrs = null; // nearest-station CRS shown on the located/idle screen

let stations = [];           // [{c,n,y,x}]
let crsIndex = new Map();    // CRS -> {y,x}
let lastFix = null;
let speedMph = 0;
let bearing = null;

let discovery = { stationCrs: null, services: null };
let candidates = [];
let candidateIdx = 0;

let locked = null;           // {uid, op}
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
  if (m > 180) return fmtClock(d);
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
function platformOf(meta) {
  const p = meta && meta.platform;
  return p ? (p.actual || p.planned || "") : "";
}
function destInfo(svc) {
  const d = svc.destination && svc.destination[0] && svc.destination[0].location;
  return {
    name: (d && d.description) || "—",
    crs: (d && d.shortCodes && d.shortCodes[0]) || null,
  };
}

// ---------- RTT API ----------
async function api(path) {
  // API_BASE is empty for same-origin (Pages Functions). Only the leftover
  // placeholder from an external-Worker setup is treated as "not configured".
  if (API_BASE.includes("example.workers.dev")) {
    throw new Error("API not configured. Set API_BASE in config.js.");
  }
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
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

  let mps = (typeof c.speed === "number" && c.speed >= 0) ? c.speed : null;
  if (mps == null && lastFix) {
    const dt = (fix.t - lastFix.t) / 1000;
    if (dt > 0) mps = distanceM(lastFix, fix) / dt;
  }
  if (mps != null) speedMph = mps * 2.23694;

  if (typeof c.heading === "number" && !isNaN(c.heading) && speedMph > STOPPED_MPH) {
    bearing = c.heading;
  } else if (lastFix && distanceM(lastFix, fix) > 8) {
    bearing = bearingDeg(lastFix, fix);
  }

  lastFix = fix;
  updateSpeedReadout();
  evaluate();
}

function startGeo() {
  if (!navigator.geolocation) return;
  const opts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };
  // One quick request to get an initial fix fast, plus a continuous watch.
  navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: true, timeout: 15000 });
  navigator.geolocation.watchPosition(onPosition, onPositionError, opts);
}

function onPositionError(err) {
  if (current === State.CONFIRMED) return;
  if (err.code === err.PERMISSION_DENIED) {
    setStatus("NO GPS", "err");
    renderNotice("LOCATION BLOCKED", "Allow location access for this site, then reload. My Train needs GPS to find your train.", false);
  } else {
    setStatus("GPS ERROR", "err");
    renderNotice("WAITING FOR GPS", "Couldn't get a location fix. Move near a window if you can.", true);
  }
}

function evaluate() {
  if (current === State.CONFIRMED || !lastFix) return;

  if (speedMph >= MOVING_MPH) {
    if (current !== State.MOVING) enterMoving();
    return;
  }

  // Within range of a station (and not hurtling past) -> show its departures.
  const near = nearestStation(lastFix, STATION_RADIUS_M);
  if (near) {
    if (current !== State.STATION || discovery.stationCrs !== near.station.c) enterStation(near.station);
    return;
  }

  // We have a fix, but you're not at a station or clearly on a moving train.
  if (current !== State.STATION && current !== State.MOVING) showLocated();
}

// Shown when GPS is working but you're neither at a station nor on a fast train
// (e.g. testing at home). Proves the location worked and offers the nearest board.
function showLocated() {
  const near = nearestStation(lastFix);
  const crs = near ? near.station.c : null;
  if (current === State.IDLE && idleCrs === crs) return; // avoid re-render churn
  current = State.IDLE;
  idleCrs = crs;
  setStatus("LOCATED", "ok");

  const dist = near
    ? (near.distance < 1000 ? `${Math.round(near.distance)} m` : `${(near.distance / 1000).toFixed(1)} km`)
    : "";
  $screen.innerHTML = `<div class="notice">
    <div class="big">GOT YOUR LOCATION ✓</div>
    <div class="sub">You're not at a station or on a moving train yet.</div>
    ${near ? `<div class="screen-title" style="margin-top:8px">Nearest station</div>
      <div class="big" style="font-size:30px">${esc(near.station.n)}</div>
      <div class="sub">${dist} away</div>
      <button class="btn btn-wide" id="see-near">SEE ${esc(near.station.c)} DEPARTURES</button>` : ""}
    <div class="sub">Board a train and I'll work out which one you're on.</div>
  </div>`;
  const b = document.getElementById("see-near");
  if (b && near) b.onclick = () => enterStation(near.station);
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
    discovery.services = data.services || [];
    renderStation(station, discovery.services);
  } catch (e) {
    renderNotice("CAN'T LOAD DEPARTURES", e.message, false, true);
  }
}

function renderStation(station, services) {
  const cards = services.length
    ? services.map(departureCard).join("")
    : `<div class="notice"><div class="big">No departures listed</div></div>`;
  $screen.innerHTML =
    `<div class="screen-title">${esc(station.n)} · departures</div>${cards}` +
    refreshButton("Reload departures", "reload-board");
  bindCards();
  document.getElementById("reload-board").onclick = () => enterStation(station);
}

function departureCard(s) {
  const dep = s.temporalData && s.temporalData.departure;
  const dest = destInfo(s);
  const booked = bookedTime(dep);
  const live = bestTime(dep);
  const late = latenessMin(dep) >= 1;
  const cancelled = (s.temporalData && (s.temporalData.displayAs === "CANCELLED")) ||
    (dep && dep.isCancelled);
  const timeHtml = cancelled
    ? `<span class="badge-late">CANCELLED</span>`
    : (late
      ? `<span class="strike">${fmtClock(booked)}</span> <span class="badge-late">${fmtClock(live)}</span>`
      : `${fmtClock(live || booked)}`);
  const plat = platformOf(s.locationMetadata);
  const op = (s.scheduleMetadata && s.scheduleMetadata.operator && s.scheduleMetadata.operator.name) || "";
  const uid = (s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity) || "";
  return `<button class="card" data-uid="${esc(uid)}" data-op="${esc(op)}">
    <div class="card-row"><span class="card-time">${timeHtml}</span></div>
    <div class="card-dest">${esc(dest.name)}</div>
    <div class="card-meta"><span>${esc(op)}</span><span class="card-plat">${plat ? "Plat " + esc(plat) : "Plat —"}</span></div>
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
    const services = data.services || [];
    discovery = { stationCrs: ahead.station.c, services };
    candidates = rankByDirection(services, ahead.station);
    if (candidates.length) { candidateIdx = 0; renderGuess(); }
    else renderFallbackList(ahead.station, services);
  } catch (e) {
    renderNotice("CAN'T IDENTIFY TRAIN", e.message, false, true);
  }
}

// Rank departures so those heading our way come first (using destination CRS coords).
function rankByDirection(services, atStation) {
  const from = { y: atStation.y, x: atStation.x };
  return services
    .map((s) => {
      const crs = destInfo(s).crs;
      const dest = crs ? crsIndex.get(crs) : null;
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
        <div class="card-row"><span class="card-time">${time}</span></div>
        <div class="card-dest">${esc(dest.name)}</div>
        <div class="card-meta"><span>${esc(op)}</span></div>
        <div class="candidate-count">${remaining > 0 ? remaining + " other option(s)" : "last option"}</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-yes" id="g-yes">✓ YES</button>
        <button class="btn btn-no" id="g-no">✗ NOT THIS ONE</button>
      </div>
    </div>
    <button class="link-btn" id="g-list">Show all departures instead</button>`;
  document.getElementById("g-yes").onclick = () => lockOnto(uid, op);
  document.getElementById("g-no").onclick = nextCandidate;
  document.getElementById("g-list").onclick = () =>
    renderFallbackList({ c: discovery.stationCrs, n: discovery.stationCrs }, discovery.services);
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
    refreshButton("Re-scan", "rescan");
  bindCards();
  document.getElementById("rescan").onclick = enterMoving;
}

// ---------- STATE 3: confirmed ----------
function lockOnto(uid, op) {
  if (!uid) return;
  locked = { uid, op: op || "" };
  sessionStorage.setItem("mytrain.locked", JSON.stringify(locked));
  current = State.CONFIRMED;
  setStatus("TRAIN LOCKED", "ok");
  loadService();
  startAutoRefresh();
}
function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (current === State.CONFIRMED) loadService(true); }, REFRESH_MS);
}
async function loadService(silent) {
  if (!locked) return;
  if (!silent) renderNotice("LOADING TRAIN", "Fetching live progress…", true);
  try {
    const data = await api(`/api/service?uid=${encodeURIComponent(locked.uid)}`);
    renderTrain(data.service || data);
  } catch (e) {
    if (!silent) renderNotice("CAN'T LOAD TRAIN", e.message, false, true, true);
  }
}

function renderTrain(svc) {
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

  const nextIdx = arrived ? -1 : Math.min(lastDeparted + 1, finalIdx);
  const next = nextIdx >= 0 ? stops[nextIdx] : null;
  const after = next && nextIdx + 1 <= finalIdx && nextIdx + 1 !== finalIdx ? stops[nextIdx + 1] : null;

  const probe = next || final;
  const probeTd = (probe.temporalData && (probe.temporalData.arrival || probe.temporalData.departure)) || null;
  const delayMin = latenessMin(probeTd);

  const reasons = svc.reasons && svc.reasons[0];
  const reason = reasons ? (reasons.longText || reasons.shortText || "") : "";

  const op = (svc.scheduleMetadata && svc.scheduleMetadata.operator && svc.scheduleMetadata.operator.name) || locked.op || "";
  const finalName = locName(final);
  const headcode = (svc.scheduleMetadata && (svc.scheduleMetadata.trainReportingIdentity || svc.scheduleMetadata.identity)) || "";

  let html = `<div class="train-head">
      <div class="op">${esc(op)}</div>
      <div class="final">to ${esc(finalName)}${headcode ? `<br>${esc(headcode)}` : ""}</div>
    </div>`;

  if (arrived) {
    html += `<div class="delay-banner delay-ok">ARRIVED AT ${esc(finalName).toUpperCase()}</div>`;
  } else if (delayMin >= 2) {
    html += `<div class="delay-banner delay-bad">DELAYED ${delayMin} MIN${reason ? `<div class="delay-reason">${esc(reason)}</div>` : ""}</div>`;
  } else {
    html += `<div class="delay-banner delay-ok">ON TIME${reason ? `<div class="delay-reason">${esc(reason)}</div>` : ""}</div>`;
  }

  if (!arrived && next) {
    html += stopBlock("NEXT STOP", next);
    if (after) html += stopBlock("THEN", after);
    if (final !== next && final !== after) html += stopBlock("FINAL DESTINATION", final, true);
  }

  html += `<button class="btn btn-wide refresh-btn" id="refresh-now">↻ REFRESH</button>`;
  html += `<div class="updated-note">Updated ${fmtClock(new Date())} · auto-refresh 60s</div>`;
  html += `<button class="link-btn" id="forget">Not this train? Start over</button>`;

  $screen.innerHTML = html;
  document.getElementById("refresh-now").onclick = () => loadService(false);
  document.getElementById("forget").onclick = forgetTrain;
}

function locName(stop) {
  return (stop.location && (stop.location.description || (stop.location.shortCodes && stop.location.shortCodes[0]))) || "—";
}

function stopBlock(label, stop, isFinal) {
  const td = stop.temporalData || {};
  const tdArr = td.arrival || td.departure;       // intermediate/destination use arrival; origin uses departure
  const arr = bestTime(tdArr);
  const booked = bookedTime(tdArr);
  const plat = platformOf(stop.locationMetadata);
  const showBooked = booked && arr && Math.abs(booked - arr) >= 60000;
  return `<div class="stop${isFinal ? " final" : ""}">
    <div class="stop-label">${label}</div>
    <div class="stop-name">${esc(locName(stop))}</div>
    <div class="stop-bottom">
      <span class="stop-eta">${etaText(arr)}</span>
      <span class="stop-time">${fmtClock(arr)}${showBooked ? ` <span class="strike">${fmtClock(booked)}</span>` : ""}</span>
    </div>
    ${plat ? `<div class="stop-plat">Plat ${esc(plat)}</div>` : ""}
  </div>`;
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
  if (retry) retry.onclick = () => {
    if (current === State.CONFIRMED) return loadService(false);
    current = State.ACQUIRING;
    if (!lastFix) startGeo();
    evaluate();
  };
  const f2 = document.getElementById("forget2");
  if (f2) f2.onclick = forgetTrain;
}
function refreshButton(label, id) { return `<button class="btn btn-wide" id="${id}">↻ ${esc(label)}</button>`; }
function bindCards() {
  $screen.querySelectorAll(".card").forEach((el) => {
    el.onclick = () => lockOnto(el.dataset.uid, el.dataset.op);
  });
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- boot ----------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

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
    crsIndex = new Map(stations.map((s) => [s.c, { y: s.y, x: s.x }]));
  } catch (_) {
    if (current !== State.CONFIRMED) renderNotice("LOAD ERROR", "Couldn't load station data. Reload the app.", false, true);
  }

  if (!navigator.geolocation) {
    if (current !== State.CONFIRMED) renderNotice("NO GPS", "This device has no geolocation support.", false);
    return;
  }
  startGeo();

  // If no fix and no error after a while, nudge the user about permissions/signal.
  setTimeout(() => {
    if (!lastFix && current === State.ACQUIRING) {
      renderNotice("STILL FINDING YOU",
        "Check that location is allowed for this site (tap the icon left of the address) and that battery saver is off. Being near a window helps.",
        true, true);
    }
  }, 15000);
}

boot();
