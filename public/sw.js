/* My Train service worker — caches the app shell for offline launch.
 * Live API requests (/api/*) and other origins always go to the network. */

const CACHE = "mytrain-shell-v7";
const SHELL = [
  "./",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./vendor/qrcode.js",
  "./manifest.json",
  "./stations.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// A redirected response can't be used to satisfy a navigation request, so strip
// the redirect by rebuilding the response.
function clean(res) {
  if (!res || !res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // other origins -> network
  if (url.pathname.startsWith("/api/")) return;    // live data -> never cache

  // Navigations always get the cached app shell (the clean root document),
  // falling back to the network on a cold cache.
  if (req.mode === "navigate") {
    e.respondWith(
      caches.match("./").then((shell) => shell || fetch(req).then(clean).catch(() => caches.match("./")))
    );
    return;
  }

  // Other shell assets: cache-first, with a safe offline fallback.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return clean(res);
        })
        .catch(() => new Response("", { status: 504, statusText: "Offline" }));
    })
  );
});
