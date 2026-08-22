// StockFlow — app-shell service worker.
//
// Two different caching rules, because the app has two kinds of request:
//
//   * Navigations (someone reloads /sales on the shop floor) go NETWORK
//     FIRST and fall back to the cached shell. The old version cached exact
//     URLs only, so reloading a route the device had never opened while
//     online dropped to the browser's error page — and because it answered
//     from cache first, a fresh deploy took an extra reload to appear.
//
//   * Hashed build assets (/static/**) go CACHE FIRST. Their filenames
//     already contain a content hash, so a cached one is never stale — a new
//     build simply requests a new name.
//
// Cross-origin requests (Supabase, Paystack) are never touched: offline data
// handling lives in the app layer, see lib/offlineCache.ts and
// lib/offlineQueue.ts.

const CACHE_NAME = 'stockflow-shell-v2';
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  // Seed the shell so a route that was never visited online still opens.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([SHELL_URL, '/manifest.json']))
      .catch(() => undefined) // a missing optional file must not block install
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (response && response.status === 200 && response.type === 'basic') {
    const clone = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave Supabase/Paystack alone

  // ---- Navigations: network first, shell as the offline fallback ----
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => putInCache(SHELL_URL, response))
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(SHELL_URL)) || (await cache.match(request)) || Response.error();
        })
    );
    return;
  }

  // ---- Hashed build output: cache first, it can't go stale ----
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((response) => putInCache(request, response))
      )
    );
    return;
  }

  // ---- Everything else same-origin: serve cache, refresh in the background ----
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => putInCache(request, response))
        .catch(() => cached);
      return cached || network;
    })
  );
});
