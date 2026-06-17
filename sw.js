// TPAC 班表系統 — Service Worker V22.7.3
// ★ 每次部署 index.html 都要同步更新這裡的版本號，才能強制清除舊快取
const CACHE_NAME = 'tpac-v22-7-3';
const BASE = '/team-schedule-viewer/';

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll([
                BASE,
                BASE + 'index.html',
                BASE + 'manifest.json'
            ]).catch(err => console.warn('[SW] Cache partial fail:', err));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => {
                    console.log('[SW] Deleting old cache:', k);
                    return caches.delete(k);
                })
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // ★ 修正：外部/CDN 資源一律不攔截，讓瀏覽器直接處理
    // 包含 Firebase SDK (gstatic.com), Google Fonts, unpkg, tailwind CDN
    const isExternal = (
        url.hostname !== self.location.hostname ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('unpkg.com') ||
        url.hostname.includes('tailwindcss.com') ||
        url.hostname.includes('firebaseapp.com') ||
        url.hostname.includes('firebasestorage.app')
    );

    if (isExternal) {
        // 直接 return，不呼叫 event.respondWith，讓瀏覽器自己處理
        return;
    }

    // 本地資源：Network First（有網路就抓新版並更新快取，離線才回退）
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
