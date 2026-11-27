// Offline shell: the app and the lake search index are cached so the map opens without signal.
// Lake tiles are fetched with range requests and are left to the browser's HTTP cache.
const CACHE = 'icebuddy-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'data/mn/lake_index.json', 'data/mn/borders.json'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || e.request.headers.has('range') || u.pathname.endsWith('.pmtiles')) return;
  // Network first, falling back to the cache when offline.
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match(new URL('./', self.registration.scope).href))));
});
