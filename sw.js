// TPAC 班表系統 — Service Worker V22.10 (離線強化版)
const CACHE_NAME = 'tpac-v22-10';
const BASE = '/team-schedule-viewer/';

// 核心本機靜態資源與外部固定版本函式庫
const PRE_CACHE_RESOURCES = [
    BASE,
    BASE + 'index.html',
    BASE + 'manifest.json',
    BASE + 'icon-192.png',
    BASE + 'icon-512.png',
    'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    'https://unpkg.com/@babel/standalone@7.27.1/babel.min.js',
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;700;900&display=swap',
    // Firebase SDK（版本須與 index.html 一致）
    'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js',
    'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js',
    'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js'
];

// 逐一預快取：單一資源失敗只略過該項，不影響其他資源（避免 addAll 全有全無）
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(
                PRE_CACHE_RESOURCES.map(url =>
                    cache.add(url).catch(err => console.warn('[SW] Pre-cache fail:', url, err))
                )
            )
        )
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

    // 1. Firebase 即時 API 與 Firestore 通訊：必須走網路，不快取
    const isFirebaseAPI = (
        url.hostname.includes('firestore.googleapis.com') ||
        url.hostname.includes('identitytoolkit.googleapis.com') ||
        url.hostname.includes('securetoken.googleapis.com')
    );
    if (isFirebaseAPI) {
        event.respondWith(fetch(event.request));
        return;
    }

    // 2. 外部靜態資源（React, Babel, Fonts, Tailwind, Firebase SDK）：Cache-First 策略
    const isExternalStatic = (
        url.hostname.includes('unpkg.com') ||
        url.hostname.includes('cdn.tailwindcss') ||
        url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com') ||
        url.hostname.includes('gstatic.com')
    );

    if (isExternalStatic) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    if (response && response.status === 200) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // 3. 本地 App 核心頁面資源：Network-First，斷網時回退到本地快取
    //    ignoreSearch：index.html?v=時間戳 離線時也能命中快取
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response && response.status === 200) {
                    const cloned = response.clone();
                    // 以不含查詢字串的網址存放，避免 ?v=... 讓快取無限增長
                    const reqUrl = new URL(event.request.url);
                    reqUrl.search = '';
                    caches.open(CACHE_NAME).then(cache => cache.put(reqUrl.toString(), cloned));
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request, { ignoreSearch: true }).then(cached => {
                    if (cached) return cached;
                    return caches.match(BASE + 'index.html');
                });
            })
    );
});
