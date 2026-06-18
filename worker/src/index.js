/**
 * My Train — Cloudflare Worker
 *
 * Proxies the Realtime Trains (RTT) Pull API so the PWA never sees the
 * credentials. RTT uses HTTP Basic Auth; the username/password live as Worker
 * secrets (RTT_USERNAME / RTT_PASSWORD) and are injected here.
 *
 * Routes:
 *   GET /api/board/:crs                       -> live departures for a station
 *   GET /api/service/:uid/:year/:month/:day   -> full service detail (calling points)
 *   GET /health                               -> liveness check (no RTT call)
 *   OPTIONS *                                 -> CORS preflight
 */

const RTT_BASE = "https://api.rtt.io/api/v1/json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extraHeaders,
    },
  });
}

const isCrs = (s) => /^[A-Za-z]{3}$/.test(s);
const isUid = (s) => /^[A-Za-z0-9]{1,12}$/.test(s);
const isNum = (s, len) => new RegExp(`^\\d{${len}}$`).test(s);

async function fetchRtt(path, env, ctx, maxAgeSeconds) {
  if (!env.RTT_USERNAME || !env.RTT_PASSWORD) {
    return json(
      { error: "Worker is missing RTT_USERNAME / RTT_PASSWORD secrets." },
      500
    );
  }

  const url = `${RTT_BASE}${path}`;

  // Short-lived edge cache to soften poor connectivity and ease RTT free-tier limits.
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const r = new Response(cached.body, cached);
    Object.entries(CORS).forEach(([k, v]) => r.headers.set(k, v));
    r.headers.set("X-Cache", "HIT");
    return r;
  }

  const auth = "Basic " + btoa(`${env.RTT_USERNAME}:${env.RTT_PASSWORD}`);
  let upstream;
  try {
    upstream = await fetch(url, { headers: { Authorization: auth } });
  } catch (err) {
    return json({ error: "Could not reach Realtime Trains.", detail: String(err) }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return json(
      { error: `RTT responded ${upstream.status}`, detail: text.slice(0, 200) },
      upstream.status === 401 ? 502 : upstream.status
    );
  }

  const data = await upstream.text();
  const resp = new Response(data, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
      ...CORS,
      "X-Cache": "MISS",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed." }, 405);
    }

    const { pathname } = new URL(request.url);
    const parts = pathname.split("/").filter(Boolean); // e.g. ["api","board","PAD"]

    if (parts.length === 1 && parts[0] === "health") {
      return json({ ok: true });
    }

    if (parts[0] === "api" && parts[1] === "board" && parts.length === 3) {
      const crs = parts[2];
      if (!isCrs(crs)) return json({ error: "Invalid station code." }, 400);
      return fetchRtt(`/search/${crs.toUpperCase()}`, env, ctx, 30);
    }

    if (parts[0] === "api" && parts[1] === "service" && parts.length === 6) {
      const [, , uid, y, m, d] = parts;
      if (!isUid(uid) || !isNum(y, 4) || !isNum(m, 2) || !isNum(d, 2)) {
        return json({ error: "Invalid service reference." }, 400);
      }
      return fetchRtt(`/service/${uid.toUpperCase()}/${y}/${m}/${d}`, env, ctx, 30);
    }

    return json({ error: "Not found." }, 404);
  },
};
