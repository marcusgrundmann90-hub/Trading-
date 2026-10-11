// Trading Radar service worker.
// - App shell: precached, cache-first (versioned cache, old versions deleted on activate).
// - data/stocks.json: network-first, cached copy as offline fallback.
// - Binance and everything cross-origin: not intercepted (always live, never cached).
// VERSION is stamped with the commit SHA by the Pages workflow on every deploy.
const VERSION = 'v1.0.0';
const SHELL_CACHE = `tr-shell-${VERSION}`;
const DATA_CACHE = 'tr-data';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ui/format.js',
  './ui/store.js',
  './ui/charts.js',
  './lib/indicators.js',
  './lib/signals.js',
  './lib/risk.js',
  './lib/engine.js',
  './lib/data.js',
  './lib/demo.js',
  './vendor/lightweight-charts.standalone.production.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './data/universe.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 'reload' bypasses the HTTP cache so a new version never precaches stale files.
    const results = await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    const failed = results.map((r, i) => (r.status === 'rejected' ? SHELL[i] : null)).filter(Boolean);
    if (failed.length) console.warn('[sw] nicht vorab gecacht:', failed);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('tr-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.disable(); } catch { /* ignore */ } }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const scopeURL = new URL(self.registration.scope);

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  const key = new URL(request.url);
  key.search = '';
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) await cache.put(key.href, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key.href);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  // runtime-cache further same-origin GETs (e.g. files added after this SW version)
  if (res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function navigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = (await cache.match('./index.html')) || (await cache.match('./'));
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch (err) {
    return new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><p style="font-family:system-ui;padding:24px">Offline – Trading Radar konnte nicht geladen werden.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scopeURL.origin || !url.pathname.startsWith(scopeURL.pathname)) return; // Binance & co: pass-through

  const rel = url.pathname.slice(scopeURL.pathname.length);
  if (rel === 'data/stocks.json') { event.respondWith(networkFirst(request)); return; }
  if (request.mode === 'navigate') { event.respondWith(navigate(request)); return; }
  event.respondWith(cacheFirst(request));
});
