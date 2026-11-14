/* WheelGrade service worker — makes /app installable and loads offline.
   Safety rules (this is a live trading app):
   - /app/api/* and /app/auth/* NEVER touch the cache: always network.
     Stale prices, grades, or auth state would be worse than no data.
   - App shell (index.html, app.js, styles.css): network-first, so a
     deploy reaches the user, with the cached shell as the offline
     fallback.
   - Icons + manifest: cache-first, they almost never change.
   - Any other same-origin GET under /app: cache-first, then network.
   Scope is /app/ (this file lives at /app/sw.js), so the landing
   pages at the domain root are untouched. */
var CACHE = 'wheelgrade-v1';
var SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/styles.css',
  '/app/manifest.json',
  '/app/icon-192.png',
  '/app/icon-512.png',
  '/app/icon-512-maskable.png',
  '/app/apple-touch-icon.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/app/') && url.pathname !== '/app') return;

  // API and auth: network only, never cached.
  if (url.pathname.startsWith('/app/api/') || url.pathname.startsWith('/app/auth/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Navigations + shell files: network first, cached shell offline.
  var isShell = SHELL.indexOf(url.pathname) !== -1 || req.mode === 'navigate';
  if (isShell) {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/app/index.html');
        });
      })
    );
    return;
  }

  // Other same-origin assets under /app: cache first, then network.
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    })
  );
});
