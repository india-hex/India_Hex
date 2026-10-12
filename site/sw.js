// Service worker: cache the app shell and immutable data (versioned URLs) for fast repeat visits.
const SHELL = 'indiahex-shell-v3';
const DATA = 'indiahex-data-v3';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', 'index.html', 'css/app.css', 'favicon.svg'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || e.request.headers.has('range')) return; // ranged reads go straight to the network/HTTP cache
  // versioned data (?v=...) never changes: cache first
  if (url.origin === location.origin && url.searchParams.has('v')) {
    e.respondWith(caches.open(DATA).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  // app shell + config: network first, cache as fallback (offline)
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
  }
});
