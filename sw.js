const CACHE_VERSION = 'wordshift-pwa-v2';
const APP_SHELL = [
  './Wordshift.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

function isDynamicApi(url) {
  if (url.pathname.startsWith('/.netlify/functions/')) return true;
  return /^\/api\/word-review(?:\/|$)/.test(url.pathname);
}

function shouldCache(req, res) {
  if (!res || !res.ok) return false;
  const url = new URL(req.url);
  if (isDynamicApi(url)) return false;
  const cc = String(res.headers.get('cache-control') || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('no-cache') || cc.includes('private')) return false;
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE_VERSION ? Promise.resolve() : caches.delete(k))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Never cache dynamic function responses (word review API must always be fresh).
  if (isDynamicApi(url)) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE_VERSION);
        if (shouldCache(req, fresh)) {
          cache.put('./Wordshift.html', fresh.clone());
        }
        return fresh;
      } catch (_) {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match(req)) || (await cache.match('./Wordshift.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      if (shouldCache(req, fresh)) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (_) {
      return cached;
    }
  })());
});
