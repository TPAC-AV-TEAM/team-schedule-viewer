// TPAC 班表系統 — Service Worker V22.7
// 功能：讓 Chrome 識別此站為可安裝的 PWA
// 快取策略：網路優先（班表需要即時資料），失敗才用快取

const CACHE_NAME = 'tpac-v22';

// 安裝事件：快取靜態殼層資源
self.addEventListener('install', event => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll([
                '/',
                '/index.html',
                '/manifest.json'
            ]).catch(err => {
                // 部分資源快取失敗不阻斷安裝
                console.warn('[SW] Cache addAll partial fail:', err);
            });
        })
    );
    self.skipWaiting();
});

// 啟動事件：清除舊版快取
self.addEventListener('activate', event => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// Fetch 事件：網路優先，失敗回退到快取
self.addEventListener('fetch', event => {
    const { request } = event;

    // 只處理 GET 請求
    if (request.method !== 'GET') return;

    // Firebase / CDN 請求：純網路，不快取
    const url = new URL(request.url);
    const isExternal = (
        url.hostname.includes('firebasejs') ||
        url.hostname.includes('firestore') ||
        url.hostname.includes('firebase') ||
        url.hostname.includes('googleapis') ||
        url.hostname.includes('unpkg.com') ||
        url.hostname.includes('cdn.tailwindcss') ||
        url.hostname.includes('fonts.gstatic') ||
        url.hostname.includes('fonts.googleapis')
    );

    if (isExternal) {
        event.respondWith(fetch(request));
        return;
    }

    // 本地資源：網路優先，離線回退快取
    event.respondWith(
        fetch(request)
            .then(response => {
                if (response && response.status === 200) {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, cloned));
                }
                return response;
            })
            .catch(() => caches.match(request))
    );
});
