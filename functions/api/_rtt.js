/* Shared helper for the My Train Pages Functions.
 * Files/dirs starting with "_" are not routed by Cloudflare Pages, so this is a
 * private module imported by the route handlers.
 *
 * Proxies the Realtime Trains API v2 (https://data.rtt.io) with a bearer token
 * kept server-side. Set ONE of these on the Pages project (Settings → Variables
 * and Secrets):
 *   - RTT_ACCESS_TOKEN  : a long-life access token, used directly.
 *   - RTT_REFRESH_TOKEN : a refresh token; exchanged for short-life access tokens.
 * Optional RTT_API_VERSION (ISO date) pins the API version.
 */

const RTT_BASE = "https://data.rtt.io";

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// Cached minted access token (per isolate).
let tokenCache = null;

async function getBearer(env) {
  if (env.RTT_ACCESS_TOKEN) return env.RTT_ACCESS_TOKEN;
  if (!env.RTT_REFRESH_TOKEN) {
    throw new Error("Missing RTT_ACCESS_TOKEN or RTT_REFRESH_TOKEN. Set it in the Pages project settings.");
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

export async function proxy(upstreamPath, env, ctx, maxAgeSeconds = 30) {
  const url = `${RTT_BASE}${upstreamPath}`;

  // Short-lived edge cache (eases poor connectivity and the RTT rate limits).
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
      "X-Cache": "MISS",
    },
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
