/**
 * My Train — Worker (Workers Static Assets).
 *
 * Static files in ./public are served automatically; this Worker only handles
 * requests that don't match a static file — i.e. the API under /api/*. It
 * proxies the Realtime Trains API v2 (https://data.rtt.io) with a bearer token
 * kept server-side. Set ONE of these as a Worker variable/secret:
 *   - RTT_ACCESS_TOKEN  : a long-life access token, used directly.
 *   - RTT_REFRESH_TOKEN : a refresh token; exchanged for short-life access tokens.
 * Optional RTT_API_VERSION (ISO date) pins the API version.
 */

const RTT_BASE = "https://data.rtt.io";

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

const isCrs = (s) => /^[A-Za-z]{3}$/.test(s);
const isUid = (s) => /^[A-Za-z0-9:_-]{5,48}$/.test(s) && s.includes(":");

let tokenCache = null; // minted access token, per isolate

async function getBearer(env) {
  if (env.RTT_ACCESS_TOKEN) return env.RTT_ACCESS_TOKEN;
  if (!env.RTT_REFRESH_TOKEN) {
    throw new Error("Missing RTT_ACCESS_TOKEN or RTT_REFRESH_TOKEN. Set it in the Worker's settings.");
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

// RTT doesn't document a rate-limit header in its public spec, but if it (or
// a future version) ever sends one, this forwards it under a stable name
// instead of us hardcoding a guess at the exact header — the client only
// shows anything when one of these is actually present.
function rateLimitHeaders(upstreamHeaders) {
  const out = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    if (/ratelimit/i.test(key)) out[`x-rtt-${key.toLowerCase()}`] = value;
  }
  return out;
}

async function proxy(upstreamPath, env, ctx, maxAgeSeconds = 30) {
  const url = `${RTT_BASE}${upstreamPath}`;

  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
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

  if (upstream.status === 204) {
    return json({ services: [] }, 200, { "Cache-Control": `public, max-age=${maxAgeSeconds}` });
  }
  if (upstream.status === 429) {
    const retry = upstream.headers.get("Retry-After") || "30";
    return json({ error: "Rate limited by Realtime Trains. Try again shortly." }, 429, {
      "Retry-After": retry,
      ...rateLimitHeaders(upstream.headers),
    });
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
      "X-Cache": "MISS",
      ...rateLimitHeaders(upstream.headers),
    },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);
    const parts = pathname.split("/").filter(Boolean);

    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

    // GET /api/health
    if (pathname === "/api/health") return json({ ok: true });

    // GET /api/board/:crs
    if (parts[0] === "api" && parts[1] === "board" && parts.length === 3) {
      const crs = parts[2];
      if (!isCrs(crs)) return json({ error: "Invalid station code." }, 400);
      const code = encodeURIComponent(`gb-nr:${crs.toUpperCase()}`);
      return proxy(`/rtt/location?code=${code}`, env, ctx, 30);
    }

    // GET /api/service?uid=<uniqueIdentity>
    if (parts[0] === "api" && parts[1] === "service" && parts.length === 2) {
      const uid = searchParams.get("uid") || "";
      if (!isUid(uid)) return json({ error: "Invalid service identity." }, 400);
      return proxy(`/rtt/service?uniqueIdentity=${encodeURIComponent(uid)}`, env, ctx, 30);
    }

    return json({ error: "Not found." }, 404);
  },
};
