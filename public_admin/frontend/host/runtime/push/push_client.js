(function() {
    'use strict';

    function hasLoginCookie() {
        try {
            return document.cookie.indexOf('ak_username=') !== -1;
        } catch(e) {
            return false;
        }
    }

    function setupWebPush() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription) return;
        if (!permission.isSupported || !permission.isSupported()) return;
        if (!hasLoginCookie()) return;
        if (permission.getPermission && permission.getPermission() === 'granted') {
            subscription.registerSubscription();
            return;
        }
        if (permission.getPermission && permission.getPermission() === 'denied') return;
        try {
            var askedAt = parseInt(localStorage.getItem('ak_push_permission_asked_at') || '0', 10) || 0;
            if (Date.now() - askedAt < 86400000) return;
        } catch(e) {
        }
        showEnableBanner(permission, subscription);
    }

    function showEnableBanner(permission, subscription) {
        if (document.getElementById('ak-push-enable-banner')) return;
        if (!document.body) {
            setTimeout(function() {
                showEnableBanner(permission, subscription);
            }, 500);
            return;
        }
        var banner = document.createElement('div');
        banner.id = 'ak-push-enable-banner';
        banner.innerHTML = '<div style="display:flex;align-items:center;gap:10px;"><div style="width:34px;height:34px;border-radius:12px;background:rgba(0,229,255,.16);display:flex;align-items:center;justify-content:center;font-size:18px;">🔔</div><div><b style="font-size:14px;">开启消息提醒</b><br><span style="font-size:12px;opacity:.78;">离线时也能收到新消息通知</span></div></div><div style="display:flex;gap:8px;"><button id="ak-push-enable-confirm" style="background:#00e5ff;color:#001018;border:none;padding:8px 14px;border-radius:18px;font-weight:bold;cursor:pointer;">开启</button><button id="ak-push-enable-close" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.28);padding:8px 12px;border-radius:18px;cursor:pointer;">稍后</button></div>';
        banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:999998;background:linear-gradient(135deg,#101729,#1f2d4a);color:#fff;border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 36px rgba(0,0,0,.34);border-radius:18px;padding:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;';
        document.body.appendChild(banner);
        var confirm = document.getElementById('ak-push-enable-confirm');
        var close = document.getElementById('ak-push-enable-close');
        if (confirm) {
            confirm.onclick = function() {
                try { localStorage.setItem('ak_push_permission_asked_at', String(Date.now())); } catch(e) {}
                permission.requestPermission().then(function(result) {
                    if (result === 'granted') {
                        subscription.registerSubscription();
                    }
                }).catch(function(){});
                banner.remove();
            };
        }
        if (close) {
            close.onclick = function() {
                try { localStorage.setItem('ak_push_permission_asked_at', String(Date.now())); } catch(e) {}
                banner.remove();
            };
        }
    }

    function registerIfGranted() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription) return;
        if (!permission.getPermission || permission.getPermission() !== 'granted') return;
        subscription.registerSubscription();
    }

    function requestAndRegister() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription || !permission.requestPermission) return Promise.resolve(false);
        return permission.requestPermission().then(function(result) {
            if (result === 'granted') {
                return subscription.registerSubscription();
            }
            return false;
        }).catch(function(){});
    }

    window.AKClientRuntimePush = window.AKClientRuntimePush || {};
    window.AKClientRuntimePush.setupWebPush = setupWebPush;
    window.AKClientRuntimePush.registerIfGranted = registerIfGranted;
    window.AKClientRuntimePush.requestAndRegister = requestAndRegister;
})();
