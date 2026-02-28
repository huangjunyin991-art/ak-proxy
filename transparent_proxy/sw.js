// AK PWA Service Worker - 离线缓存 + 导航控制
const CACHE_NAME = 'ak-pwa-v1';

// 安装时缓存关键资源
self.addEventListener('install', event => {
    self.skipWaiting();
});

// 激活时清理旧缓存
self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});

// 拦截请求：确保所有导航都在APP内
self.addEventListener('fetch', event => {
    // 只处理同源导航请求
    if (event.request.mode === 'navigate') {
        const url = new URL(event.request.url);
        // 确保导航请求在APP范围内
        if (url.origin === self.location.origin) {
            event.respondWith(fetch(event.request).catch(() => {
                return caches.match('/pages/home.html') || new Response('离线中，请检查网络连接', {
                    headers: {'Content-Type': 'text/html; charset=utf-8'}
                });
            }));
        }
    }
});
