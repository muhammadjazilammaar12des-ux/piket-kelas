/* =========================================================
   ABSENSI PIKET — OFFLINE-FIRST SERVICE WORKER
   ========================================================= */
const VERSION = 'piket-shell-v52-camera-wide-field';
const BASE = new URL('./', self.location.href);
const SHELL = new URL('./index.html', BASE).href;
const APP = new URL('./app.js', BASE).href;
const CACHE = `${VERSION}`;

const PRECACHE = [
  BASE.href,
  SHELL,
  APP
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('piket-shell-') && key !== CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  // Connectivity probe deliberately bypasses every SW cache fallback.
  // A successful response therefore proves the application origin is
  // reachable over the current network path without downloading index.html.
  try {
    const probeUrl = new URL(request.url);
    if (probeUrl.searchParams.has('__piket_probe')) {
      return;
    }
  } catch (_) {}

  // The app shell must remain available during a complete blank spot.
  if (isNavigation(request)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then(cache => cache.put(request, copy))
          );
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match(SHELL)))
    );
    return;
  }

  // Cache-first for the local app shell; external SDK/model/CDN traffic remains
  // network-driven so a stale third-party resource cannot poison the application.
  if (isSameOrigin(request)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
          }
          return response;
        });
      }).catch(() => {
        if (request.destination === 'document') return caches.match(SHELL);
        return Response.error();
      })
    );
  }
});
 
