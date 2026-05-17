(function() {
    'use strict';

    function isSupported() {
        return !!(window.isSecureContext && 'Notification' in window && navigator.serviceWorker && window.PushManager);
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
    window.AKClientRuntimePushPermission.getPermission = getPermission;
    window.AKClientRuntimePushPermission.requestPermission = requestPermission;
})();
