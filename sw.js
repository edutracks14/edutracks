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
const CACHE_NAME = 'edutracks-p6-v2';

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

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Got a fresh copy — serve it, and mirror it into the cache for
        // the rare case the server is unreachable next time.
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return networkResponse;
      })
      .catch(() =>
        // Network failed (server not running / offline) — fall back to
        // whatever we last cached, if anything.
        caches.match(event.request)
      )
  );
});
