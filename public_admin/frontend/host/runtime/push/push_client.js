(function() {
    'use strict';

    function setupWebPush() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription) return;
        if (!permission.isSupported || !permission.isSupported()) return;
        if (permission.getPermission && permission.getPermission() === 'granted') {
            subscription.registerSubscription();
        }
    }

    function requestAndRegister() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription || !permission.requestPermission) return Promise.resolve(false);
        if (permission.getPermission && permission.getPermission() === 'granted') {
            return subscription.registerSubscription();
        }
        return permission.requestPermission().then(function(result) {
            if (result === 'granted') {
                return subscription.registerSubscription();
            }
            return false;
        }).catch(function(){});
    }

    function getPermissionStatus() {
        var permission = window.AKClientRuntimePushPermission;
        if (!permission || !permission.isSupported || !permission.isSupported()) return 'unsupported';
        if (!permission.getPermission) return 'default';
        return permission.getPermission();
    }

    window.AKClientRuntimePush = window.AKClientRuntimePush || {};
    window.AKClientRuntimePush.setupWebPush = setupWebPush;
    window.AKClientRuntimePush.registerIfGranted = setupWebPush;
    window.AKClientRuntimePush.requestAndRegister = requestAndRegister;
    window.AKClientRuntimePush.getPermissionStatus = getPermissionStatus;
})();
