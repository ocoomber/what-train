/**
 * My Train — Cloudflare Worker (Realtime Trains API v2, https://data.rtt.io)
 *
 * Proxies the next-generation RTT API so the bearer token never reaches the
 * browser (RTT's terms require server-side proxying). Supports either auth mode:
 *   - RTT_ACCESS_TOKEN  : a long-life access token, used directly.
 *   - RTT_REFRESH_TOKEN : a refresh token; exchanged at /api/get_access_token
 *                         for a short-life access token, cached until it expires.
 * Optionally set RTT_API_VERSION (ISO date, e.g. "2026-04-09") to pin the API
 * version; otherwise RTT serves the latest.
 *
 * Routes (frontend-facing):
 *   GET /api/board/:crs        -> rtt/location?code=gb-nr:<CRS>   (live line-up)
 *   GET /api/service?uid=<id>  -> rtt/service?uniqueIdentity=<id> (service detail)
 *   GET /health                -> liveness (no upstream call)
 *   OPTIONS *                  -> CORS preflight
 */

const RTT_BASE = "https://data.rtt.io";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extraHeaders },
  });
}

const isCrs = (s) => /^[A-Za-z]{3}$/.test(s);
// gb-nr unique identity, namespaced or not, e.g. "gb-nr:L01525:2026-06-18" or "L01525:2026-06-18".
const isUid = (s) => /^[A-Za-z0-9:_-]{5,48}$/.test(s) && s.includes(":");

// Module-scoped cache of a minted access token (per isolate).
let tokenCache = null; // { token, exp } where exp is epoch ms

async function getBearer(env) {
  if (env.RTT_ACCESS_TOKEN) return env.RTT_ACCESS_TOKEN;
  if (!env.RTT_REFRESH_TOKEN) {
    throw new Error("Worker is missing RTT_ACCESS_TOKEN or RTT_REFRESH_TOKEN.");
  }
  if (tokenCache && tokenCache.exp - 60000 > Date.now()) return tokenCache.token;

  const res = await fetch(`${RTT_BASE}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${env.RTT_REFRESH_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}).`);
  const data = await res.json();
  if (!data.token) throw new Error("Token exchange returned no token.");
  const exp = data.validUntil ? Date.parse(data.validUntil) : Date.now() + 5 * 60000;
  tokenCache = { token: data.token, exp };
  return data.token;
}

async function proxy(upstreamPath, env, ctx, maxAgeSeconds) {
  const url = `${RTT_BASE}${upstreamPath}`;

  // Short-lived edge cache (eases poor connectivity and the RTT rate limits).
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    Object.entries(CORS).forEach(([k, v]) => r.headers.set(k, v));
    r.headers.set("X-Cache", "HIT");
    return r;
  }

  let token;
  try {
    token = await getBearer(env);
  } catch (e) {
    return json({ error: e.message }, 500);
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (env.RTT_API_VERSION) headers["Version"] = env.RTT_API_VERSION;

  let upstream;
  try {
    upstream = await fetch(url, { headers });
  } catch (err) {
    return json({ error: "Could not reach Realtime Trains.", detail: String(err) }, 502);
  }

  // 204 = valid query, no services. Normalise to an empty result the frontend understands.
  if (upstream.status === 204) {
    return json({ services: [] }, 200, { "Cache-Control": `public, max-age=${maxAgeSeconds}` });
  }
  if (upstream.status === 429) {
    const retry = upstream.headers.get("Retry-After") || "30";
    return json({ error: "Rate limited by Realtime Trains. Try again shortly." }, 429, { "Retry-After": retry });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const status = upstream.status === 401 ? 502 : upstream.status; // hide upstream auth detail
    return json({ error: `RTT responded ${upstream.status}`, detail: text.slice(0, 200) }, status);
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
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 1 && parts[0] === "health") return json({ ok: true });

    // GET /api/board/:crs
    if (parts[0] === "api" && parts[1] === "board" && parts.length === 3) {
      const crs = parts[2];
      if (!isCrs(crs)) return json({ error: "Invalid station code." }, 400);
      const code = encodeURIComponent(`gb-nr:${crs.toUpperCase()}`);
      return proxy(`/rtt/location?code=${code}`, env, ctx, 30);
    }

    // GET /api/service?uid=<uniqueIdentity>
    if (parts[0] === "api" && parts[1] === "service" && parts.length === 2) {
      const uid = url.searchParams.get("uid") || "";
      if (!isUid(uid)) return json({ error: "Invalid service identity." }, 400);
      return proxy(`/rtt/service?uniqueIdentity=${encodeURIComponent(uid)}`, env, ctx, 30);
    }

    return json({ error: "Not found." }, 404);
  },
};
