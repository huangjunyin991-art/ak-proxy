(function() {
    'use strict';

    function hasPersistCookie() {
        try {
            var context = window.AKClientRuntimeContext;
            if (context && typeof context.hasPersistCookie === 'function') {
                return context.hasPersistCookie();
            }
        } catch(e) {
        }
        return document.cookie.indexOf('ak_persist=1') !== -1;
    }

    function setupPWA() {
        function injectManifestLinkIfValid() {
            if (document.querySelector('link[rel="manifest"]')) return;
            if (!window.fetch) return;
            fetch('/admin/api/pwa-manifest', { credentials: 'same-origin', cache: 'no-store' }).then(function(resp) {
                var contentType = String((resp && resp.headers && resp.headers.get('content-type')) || '').toLowerCase();
                if (!resp || !resp.ok || (contentType.indexOf('json') === -1 && contentType.indexOf('manifest') === -1)) return null;
                return resp.text();
            }).then(function(text) {
                if (!text) return;
                var data = null;
                try {
                    data = JSON.parse(text);
                } catch(e) {
                    data = null;
                }
                if (!data || typeof data !== 'object' || !data.name) return;
                if (document.querySelector('link[rel="manifest"]')) return;
                var link = document.createElement('link');
                link.rel = 'manifest';
                link.href = '/admin/api/pwa-manifest';
                (document.head || document.documentElement).appendChild(link);
            }).catch(function(){});
        }
        injectManifestLinkIfValid();
        // theme-color不设置，保持浏览器默认样式
        // 注册Service Worker（用API路径绕过CDN对.js文件的拦截）
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/admin/api/pwa-sw', {scope: '/'}).catch(function(){});
        }
        // 如果已经是standalone模式（已安装），不显示安装提示
        if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;
        // 登录页不显示安装提示
        if (window.location.pathname.toLowerCase().indexOf('/login') !== -1) return;
        // 拦截浏览器安装事件，登录后再显示
        var deferredPrompt = null;
        window.addEventListener('beforeinstallprompt', function(e) {
            e.preventDefault();
            deferredPrompt = e;
            tryShowInstallBanner();
        });
        // 定期检查cookie状态（登录后cookie才会出现）
        var _pwaCheckTimer = setInterval(function() {
            if (deferredPrompt) tryShowInstallBanner();
            // 已显示或无事件则停止
            if (!deferredPrompt || document.getElementById('ak-pwa-banner')) clearInterval(_pwaCheckTimer);
        }, 3000);
        function tryShowInstallBanner() {
            if (!deferredPrompt) return;
            if (!hasPersistCookie() || document.cookie.indexOf('ak_username=') === -1) return;
            showInstallBanner();
        }
        function showInstallBanner() {
            if (document.getElementById('ak-pwa-banner')) return;
            // 如果用户之前关闭了提示，24小时内不再显示
            try {
                var dismissed = localStorage.getItem('ak_pwa_dismiss');
                if (dismissed && (Date.now() - parseInt(dismissed)) < 86400000) return;
            } catch(e) {}
            var banner = document.createElement('div');
            banner.id = 'ak-pwa-banner';
            banner.innerHTML = '<div style="display:flex;align-items:center;gap:12px;"><img src="/admin/api/pwa-icon/192" width="40" height="40" style="border-radius:8px;"><div><b style="font-size:14px;">安装 AK</b><br><span style="font-size:12px;opacity:0.8;">添加到桌面，获得APP体验</span></div></div><div style="display:flex;gap:8px;"><button id="ak-pwa-install" style="background:#00e5ff;color:#000;border:none;padding:8px 16px;border-radius:20px;font-weight:bold;cursor:pointer;">安装</button><button id="ak-pwa-close" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.3);padding:8px 12px;border-radius:20px;cursor:pointer;">取消</button></div>';
            banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:linear-gradient(135deg,#0a0e1a,#1a1e3a);color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;z-index:999999;box-shadow:0 -4px 20px rgba(0,0,0,0.5);font-family:sans-serif;';
            document.body.appendChild(banner);
            document.getElementById('ak-pwa-install').onclick = function() {
                if (deferredPrompt) {
                    deferredPrompt.prompt();
                    deferredPrompt.userChoice.then(function() { deferredPrompt = null; });
                }
                banner.remove();
            };
            document.getElementById('ak-pwa-close').onclick = function() {
                banner.remove();
                try { localStorage.setItem('ak_pwa_dismiss', Date.now()); } catch(e) {}
            };
        }
    }

    window.AKClientRuntimePWA = window.AKClientRuntimePWA || {};
    window.AKClientRuntimePWA.setupPWA = setupPWA;
})();
