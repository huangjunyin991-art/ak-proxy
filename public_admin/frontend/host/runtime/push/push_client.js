(function() {
    'use strict';

    var SUBSCRIPTION_ENABLED_KEY = 'ak_push_subscription_enabled';
    var lastError = '';

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
        lastError = '';
        if (!permission || !subscription || !permission.requestPermission) {
            lastError = '消息通知模块暂不可用，请刷新页面后重试';
            return Promise.resolve(false);
        }
        if (!permission.isSupported || !permission.isSupported()) {
            lastError = permission.getSupportError ? permission.getSupportError() : '当前浏览器不支持消息通知';
            return Promise.resolve(false);
        }
        if (permission.getPermission && permission.getPermission() === 'granted') {
            return subscription.registerSubscription().then(function(result) {
                if (result) setSubscriptionEnabled(true);
                if (!result && subscription.getLastError) lastError = subscription.getLastError();
                return !!result;
            }).catch(function(error) {
                lastError = error && error.message ? error.message : '开启消息通知失败，请稍后重试';
                return false;
            });
        }
        return withTimeout(permission.requestPermission(), 10000, '等待浏览器通知授权超时，请重新点击开关').then(function(result) {
            if (result === 'granted') {
                return subscription.registerSubscription().then(function(saved) {
                    if (saved) setSubscriptionEnabled(true);
                    if (!saved && subscription.getLastError) lastError = subscription.getLastError();
                    return saved;
                });
            }
            lastError = result === 'denied' ? '浏览器已阻止通知，请到站点设置中允许通知权限' : '未允许浏览器通知权限';
            return false;
        }).catch(function(error) {
            lastError = error && error.message ? error.message : '开启消息通知失败，请稍后重试';
            return false;
        });
    }

    function unregister() {
        var subscription = window.AKClientRuntimePushSubscription;
        setSubscriptionEnabled(false);
        if (!subscription || typeof subscription.unregisterSubscription !== 'function') return Promise.resolve(true);
        return subscription.unregisterSubscription();
    }

    function diagnose() {
        var subscription = window.AKClientRuntimePushSubscription;
        if (!subscription || typeof subscription.diagnoseSubscription !== 'function') {
            return Promise.resolve({last_error: '消息通知诊断模块暂不可用'});
        }
        return subscription.diagnoseSubscription();
    }

    function getPermissionStatus() {
        var permission = window.AKClientRuntimePushPermission;
        if (!permission || !permission.isSupported || !permission.isSupported()) return 'unsupported';
        if (!permission.getPermission) return 'default';
        return permission.getPermission();
    }

    function withTimeout(promise, timeoutMs, message) {
        return new Promise(function(resolve, reject) {
            var settled = false;
            var timer = setTimeout(function() {
                if (settled) return;
                settled = true;
                reject(new Error(message));
            }, timeoutMs);
            Promise.resolve(promise).then(function(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }).catch(function(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function getLastError() {
        var permission = window.AKClientRuntimePushPermission;
        var subscription = window.AKClientRuntimePushSubscription;
        if (lastError) return lastError;
        if (permission && permission.isSupported && !permission.isSupported() && permission.getSupportError) {
            return permission.getSupportError();
        }
        return subscription && subscription.getLastError ? subscription.getLastError() : '';
    }

    window.AKClientRuntimePush = window.AKClientRuntimePush || {};
    window.AKClientRuntimePush.setupWebPush = setupWebPush;
    window.AKClientRuntimePush.registerIfGranted = setupWebPush;
    window.AKClientRuntimePush.requestAndRegister = requestAndRegister;
    window.AKClientRuntimePush.unregister = unregister;
    window.AKClientRuntimePush.diagnose = diagnose;
    window.AKClientRuntimePush.getPermissionStatus = getPermissionStatus;
    window.AKClientRuntimePush.isSubscriptionEnabled = isSubscriptionEnabled;
    window.AKClientRuntimePush.getLastError = getLastError;
})();
