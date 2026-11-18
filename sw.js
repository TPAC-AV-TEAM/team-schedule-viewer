// TPAC 班表系統 — Service Worker V22.24 (Tailwind 本機化 + 預快取補洞 + 5xx 回退快取版)
const CACHE_NAME = 'tpac-v22-24';
const BASE = '/team-schedule-viewer/';
// 本機 Tailwind：檔名含版本號、內容永不變動，採 Cache-First
const TAILWIND_LOCAL = BASE + 'tailwind-3_4_16.js';

// 本地頁面的網路等待上限：訊號半通不通時，超過此時間就先用快取回應，
// 網路請求仍會在背景完成並更新快取（下次開啟即為新版）。首次使用（無快取）則繼續等網路。
const NETWORK_TIMEOUT_MS = 4000;

// 核心本機靜態資源與外部固定版本函式庫
const PRE_CACHE_RESOURCES = [
    BASE,
    BASE + 'index.html',
    BASE + 'manifest.json',
    BASE + 'icon-192.png',
    BASE + 'icon-512.png',
    TAILWIND_LOCAL,
    'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    'https://unpkg.com/@babel/standalone@7.27.1/babel.min.js',
    // Firebase SDK（版本須與 index.html 100% 一致；V22.19 起前端不再使用 Auth 模組，已移除）
    'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js',
    'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js'
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

// 補抓預快取中缺漏的項目。
// 安裝當下訊號不佳時，失敗的項目會被略過；而外部腳本是 no-cors 請求，執行期快取收不到，
// 缺漏便永遠補不上。因此由頁面載入完成後發訊息觸發，只抓缺的，已有的不重抓。
async function backfillPrecache() {
    try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.allSettled(PRE_CACHE_RESOURCES.map(async url => {
            if (await cache.match(url)) return;
            try { await cache.add(url); }
            catch (err) { console.warn('[SW] Backfill fail:', url, err); }
        }));
    } catch (err) { console.warn('[SW] Backfill error:', err); }
}

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'BACKFILL_PRECACHE') {
        event.waitUntil(backfillPrecache());
    }
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

    // 2. 外部靜態資源（React, Babel, Fonts, Firebase SDK）：Cache-First 策略
    //    （cdn.tailwindcss 判斷保留僅為相容尚未更新的舊版頁面，新版頁面已不使用）
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

    // 2b. 本機 Tailwind：Cache-First（它是 <head> 內阻塞渲染的腳本，訊號差時不能卡在網路等待）
    if (url.origin === self.location.origin && url.pathname === TAILWIND_LOCAL) {
        event.respondWith(
            caches.match(TAILWIND_LOCAL).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    if (response && response.status === 200) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(TAILWIND_LOCAL, cloned));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // 3. 本地 App 核心頁面資源：Network-First（含逾時保護），斷網或逾時時回退到本地快取
    //    ignoreSearch：index.html?v=時間戳 離線時也能命中快取
    //    V22.20：網路雖有回應但是 5xx（例如 GitHub Pages 暫時故障）時，視同網路失敗，優先使用快取；
    //    若完全沒有快取，才把這個 5xx 回應原樣交給瀏覽器（不吞掉錯誤）。
    let timer = null;
    let badResponse = null;
    const networkPromise = fetch(event.request).then(response => {
        if (response && response.status >= 500) {
            badResponse = response;
            throw new Error('HTTP ' + response.status);
        }
        if (response && response.status === 200) {
            const cloned = response.clone();
            // 以不含查詢字串的網址存放，避免 ?v=... 讓快取無限增長
            const reqUrl = new URL(event.request.url);
            reqUrl.search = '';
            caches.open(CACHE_NAME).then(cache => cache.put(reqUrl.toString(), cloned));
        }
        return response;
    });

    // 逾時：有快取就先回快取；沒快取（首次使用）就繼續等網路
    const timeoutPromise = new Promise(resolve => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS); })
        .then(() => caches.match(event.request, { ignoreSearch: true }))
        .then(cached => cached || networkPromise);

    // 讓 SW 活到背景更新完成（即使已先回了快取）；吞掉背景失敗，並清除計時器
    event.waitUntil(networkPromise.catch(() => {}).then(() => clearTimeout(timer)));

    event.respondWith(
        Promise.race([networkPromise, timeoutPromise]).catch(() => {
            return caches.match(event.request, { ignoreSearch: true }).then(cached => {
                if (cached) return cached;
                if (badResponse) return badResponse;
                return caches.match(BASE + 'index.html');
            });
        })
    );
});
