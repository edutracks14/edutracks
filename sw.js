// EduTrackS P6 — Service Worker
//
// WHY THIS FILE EXISTS: it's what lets Chrome/Edge offer "Install app" and
// keeps the app shell available if the local Python server briefly drops.
//
// PREVIOUS BEHAVIOR (the "must hard refresh" bug): the old worker cached
// files on first load and served that cache on every visit afterwards,
// so edits you saved to index.html never showed up until Ctrl+Shift+R
// forced the browser to bypass both the HTTP cache and the service worker.
//
// NEW BEHAVIOR: network-first. On every request, it tries the live file
// from your local server first and updates the cache with whatever it
// gets. It only falls back to the cached copy if the network request
// fails outright (e.g. the Python server isn't running yet). That means
// a normal reload always shows your latest saved changes, and the cache
// only exists as a safety net, not as the default source of truth.
//
// Bump this version string any time you want to force every open tab to
// drop its old cache immediately (rarely needed now, since network-first
// already avoids stale content — but harmless to bump if you ever want a
// clean slate).
const CACHE_NAME = 'edutracks-p6-v8';

// Big library files that never change: serve from the device cache first (fast start, esp. on phones).
const STATIC_LIBS = ['/xlsx.full.min.js','/jspdf.umd.min.js','/jspdf.plugin.autotable.min.js','/chart.umd.min.js','/sql-wasm.js','/sql-wasm.wasm'];

self.addEventListener('install', () => {
  // Activate this worker as soon as it finishes installing, instead of
  // waiting for every other tab running the old worker to close first.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      // Take control of any already-open tabs immediately, rather than
      // only affecting tabs opened after this activation.
      .then(() => self.clients.claim())
  );
});

// Lets index.html's registration code (on 'updatefound') tell a waiting
// worker to activate right away instead of waiting for a spare tab to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  // Only handle simple GETs — POST/PUT and cross-origin requests pass through untouched.
  if (event.request.method !== 'GET') return;
  // Never cache or intercept the API (the protected app code is served from /api/app).
  if (new URL(event.request.url).pathname.startsWith('/api/')) return;

  const path = new URL(event.request.url).pathname;
  if (STATIC_LIBS.indexOf(path) > -1) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((networkResponse) => {
        const copy = networkResponse.clone();
        if (networkResponse.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return networkResponse;
      }))
    );
    return;
  }

  // v111: stale-while-revalidate for the small shell files (PIN page, icons, manifest).
  // The PIN page opens instantly from the device and is refreshed in the background.
  // The real application is never cached here: it always comes fresh from /api/app.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) cache.put(event.request, networkResponse.clone());
            return networkResponse;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
