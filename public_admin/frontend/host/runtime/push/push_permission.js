(function() {
    'use strict';

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
        if (!isSupported()) return Promise.resolve('unsupported');
        if (Notification.permission === 'granted') return Promise.resolve('granted');
        if (Notification.permission === 'denied') return Promise.resolve('denied');
        return Notification.requestPermission();
    }

    window.AKClientRuntimePushPermission = window.AKClientRuntimePushPermission || {};
    window.AKClientRuntimePushPermission.isSupported = isSupported;
    window.AKClientRuntimePushPermission.getSupportError = getSupportError;
    window.AKClientRuntimePushPermission.getPermission = getPermission;
    window.AKClientRuntimePushPermission.requestPermission = requestPermission;
})();
