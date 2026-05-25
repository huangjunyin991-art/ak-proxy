(function() {
    'use strict';

    var lastRequestResult = {
        result: '',
        error: '',
        completed: false
    };

    function isIosDevice() {
        var ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function isStandaloneMode() {
        return !!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
    }

    function getSupportError() {
        if (!window.isSecureContext) return '当前页面不是安全 HTTPS 环境，无法开启消息通知';
        if (!('Notification' in window)) return '当前浏览器不支持消息通知';
        if (isIosDevice() && !isStandaloneMode()) return 'iPhone/iPad 需要先添加到主屏幕后，再从桌面图标打开使用消息通知';
        if (!navigator.serviceWorker) return '当前浏览器不支持 Service Worker';
        if (!window.PushManager) return '当前浏览器不支持 Web Push';
        return '';
    }

    function isSupported() {
        return !getSupportError();
    }

    function getPermission() {
        if (!('Notification' in window)) return 'unsupported';
        return Notification.permission || 'default';
    }

    function requestPermission() {
        if (!isSupported()) {
            lastRequestResult = {result: 'unsupported', error: getSupportError(), completed: true};
            return Promise.resolve('unsupported');
        }
        if (Notification.permission === 'granted') {
            lastRequestResult = {result: 'granted', error: '', completed: true};
            return Promise.resolve('granted');
        }
        lastRequestResult = {result: 'pending', error: '', completed: false};
        return new Promise(function(resolve) {
            var settled = false;
            function finish(result) {
                if (settled) return;
                settled = true;
                var value = result || Notification.permission || 'default';
                lastRequestResult = {result: value, error: '', completed: true};
                resolve(value);
            }
            try {
                var result = Notification.requestPermission(finish);
                if (result && typeof result.then === 'function') {
                    result.then(finish).catch(function() {
                        var value = Notification.permission || 'default';
                        lastRequestResult = {result: value, error: 'requestPermission rejected', completed: true};
                        finish(value);
                    });
                } else if (result) {
                    finish(result);
                }
            } catch(e) {
                lastRequestResult = {result: Notification.permission || 'default', error: e && e.message ? String(e.message) : 'requestPermission failed', completed: true};
                finish(Notification.permission || 'default');
            }
        });
    }

    function getLastRequestResult() {
        return {
            result: lastRequestResult.result || '',
            error: lastRequestResult.error || '',
            completed: !!lastRequestResult.completed
        };
    }

    window.AKClientRuntimePushPermission = window.AKClientRuntimePushPermission || {};
    window.AKClientRuntimePushPermission.isSupported = isSupported;
    window.AKClientRuntimePushPermission.getSupportError = getSupportError;
    window.AKClientRuntimePushPermission.getPermission = getPermission;
    window.AKClientRuntimePushPermission.requestPermission = requestPermission;
    window.AKClientRuntimePushPermission.getLastRequestResult = getLastRequestResult;
})();
