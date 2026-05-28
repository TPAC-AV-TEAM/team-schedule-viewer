// TPAC 班表系統 — Service Worker V22.7.1
// 修正：全部改用相對路徑，避免子路徑部署失敗

const CACHE_NAME = 'tpac-v22';

// 安裝：快取靜態殼層（相對路徑）
self.addEventListener('install', event => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // 用 self.location 動態取得正確的基底路徑
            const base = self.location.pathname.replace('sw.js', '');
            return cache.addAll([
                base,
                base + 'index.html',
                base + 'manifest.json'
            ]).catch(err => {
                console.warn('[SW] Cache addAll partial fail:', err);
            });
        })
    );
    self.skipWaiting();
});

// 啟動：清除舊版快取
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

// Fetch：網路優先，離線回退快取
self.addEventListener('fetch', event => {
    const { request } = event;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // 外部資源（Firebase、CDN）：純網路不快取
    const isExternal = (
        url.hostname !== self.location.hostname ||
        url.hostname.includes('firebasejs') ||
        url.hostname.includes('firestore') ||
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

    // 本地資源：網路優先，失敗回快取
    // 特別處理：/ 和 /index.html 視為同一資源
    event.respondWith(
        fetch(request)
            .then(response => {
                if (response && response.status === 200) {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(request, cloned);
                        // 同時存 index.html 別名，確保兩種路徑都能命中
                        if (url.pathname.endsWith('/')) {
                            const indexReq = new Request(url.href + 'index.html');
                            fetch(indexReq).then(r => { if (r.ok) cache.put(indexReq, r); });
                        }
                    });
                }
                return response;
            })
            .catch(() => {
                return caches.match(request).then(cached => {
                    if (cached) return cached;
                    // 找不到時，嘗試回傳 index.html（SPA fallback）
                    const base = self.location.pathname.replace('sw.js', '');
                    return caches.match(base + 'index.html');
                });
            })
    );
});
