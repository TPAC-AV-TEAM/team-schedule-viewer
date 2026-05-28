// AV 迴路盒查詢 — Service Worker V12.1.1
// 修正：GitHub Pages 子路徑 /Panel-circuit-box/ 部署

const CACHE_NAME = 'av-panel-v12';
const BASE = '/Panel-circuit-box/';

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll([
                BASE,
                BASE + 'index.html',
                BASE + 'manifest.json',
                BASE + 'data.json'
            ]).catch(err => console.warn('[SW] Cache partial fail:', err));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isExternal = url.hostname !== self.location.hostname;

    if (isExternal) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response && response.status === 200) {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request).then(cached => {
                    if (cached) return cached;
                    return caches.match(BASE + 'index.html');
                });
            })
    );
});
