/* Shop Tracker service worker — cache app shell only; APIs always network. */
const CACHE = 'shop-tracker-shell-v12';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/assets/styles.css',
  '/assets/app.js',
  '/logo.png',
  '/favicon.ico',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Let the browser handle audio directly (range requests)
  if (url.pathname.endsWith('.mp3')) return;
  // Never cache API or mutations — live data from network
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }
  // Network first so phones always get the newest version; cache only as offline fallback
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});
