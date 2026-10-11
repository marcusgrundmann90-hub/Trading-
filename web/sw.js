/* Big Bets – Service Worker.
 * Hält die App-Hülle offline verfügbar. Die Alarm-Daten (raw.githubusercontent.com, fremde Herkunft)
 * werden NICHT abgefangen – die App cached die letzte Liste selbst in localStorage.
 */
// VERSION is stamped with the commit SHA by the Pages workflow on every deploy.
const VERSION = 'dev';
const SHELL_CACHE = `bigbets-shell-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // z. B. raw.githubusercontent.com – nicht anfassen

  // Navigation (auch mit #id oder ?query): immer die gecachte index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { cacheName: SHELL_CACHE })
        .then((hit) => hit || fetch(req))
        .catch(() => fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req, { cacheName: SHELL_CACHE, ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
