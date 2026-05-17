(function() {
    'use strict';

    var SUBSCRIPTION_ENABLED_KEY = 'ak_push_subscription_enabled';

    function setSubscriptionEnabled(enabled) {
        try {
            localStorage.setItem(SUBSCRIPTION_ENABLED_KEY, enabled ? '1' : '0');
        } catch(e) {
        }
    }

    function isSubscriptionEnabled() {
        try {
            return localStorage.getItem(SUBSCRIPTION_ENABLED_KEY) !== '0';
        } catch(e) {
            return true;
        }
    }

    function setupWebPush() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription) return;
        if (!permission.isSupported || !permission.isSupported()) return;
        if (!isSubscriptionEnabled()) return;
        if (permission.getPermission && permission.getPermission() === 'granted') {
            subscription.registerSubscription().then(function(result) {
                if (result) setSubscriptionEnabled(true);
            });
        }
    }

    function requestAndRegister() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (!permission || !subscription || !permission.requestPermission) return Promise.resolve(false);
        if (permission.getPermission && permission.getPermission() === 'granted') {
            return subscription.registerSubscription().then(function(result) {
                if (result) setSubscriptionEnabled(true);
                return result;
            });
        }
        return permission.requestPermission().then(function(result) {
            if (result === 'granted') {
                return subscription.registerSubscription().then(function(saved) {
                    if (saved) setSubscriptionEnabled(true);
                    return saved;
                });
            }
            return false;
        }).catch(function(){});
    }

    function unregister() {
        var subscription = window.AKClientRuntimePushSubscription;
        setSubscriptionEnabled(false);
        if (!subscription || typeof subscription.unregisterSubscription !== 'function') return Promise.resolve(true);
        return subscription.unregisterSubscription();
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
    window.AKClientRuntimePush.unregister = unregister;
    window.AKClientRuntimePush.getPermissionStatus = getPermissionStatus;
    window.AKClientRuntimePush.isSubscriptionEnabled = isSubscriptionEnabled;
})();
