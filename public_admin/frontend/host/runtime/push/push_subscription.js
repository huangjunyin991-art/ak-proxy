(function() {
    'use strict';

    function urlBase64ToUint8Array(base64String) {
        var padding = '='.repeat((4 - base64String.length % 4) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var rawData = window.atob(base64);
        var outputArray = new Uint8Array(rawData.length);
        for (var i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    function fetchVapidPublicKey() {
        return fetch('/api/notify-center/web-push/vapid-public-key', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
        }).then(function(resp) {
            if (!resp || !resp.ok) return null;
            return resp.json();
        }).then(function(data) {
            var body = data && data.data ? data.data : {};
            if (!body.enabled || !body.web_push_ready || !body.public_key) return null;
            return String(body.public_key || '');
        }).catch(function() {
            return null;
        });
    }

    function getRegistration() {
        if (!navigator.serviceWorker) return Promise.resolve(null);
        return navigator.serviceWorker.ready.catch(function() { return null; });
    }

    function subscribe(registration, publicKey) {
        if (!registration || !registration.pushManager || !publicKey) return Promise.resolve(null);
        return registration.pushManager.getSubscription().then(function(existing) {
            if (existing) return existing;
            return registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        });
    }

    function saveSubscription(subscription) {
        if (!subscription) return Promise.resolve(false);
        return fetch('/api/notify-center/web-push/subscriptions', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                subscription: subscription.toJSON ? subscription.toJSON() : subscription,
                platform: navigator.platform || ''
            })
        }).then(function(resp) {
            return !!(resp && resp.ok);
        }).catch(function() {
            return false;
        });
    }

    function registerSubscription() {
        return fetchVapidPublicKey().then(function(publicKey) {
            if (!publicKey) return false;
            return getRegistration().then(function(registration) {
                return subscribe(registration, publicKey);
            }).then(function(subscription) {
                return saveSubscription(subscription);
            });
        });
    }

    window.AKClientRuntimePushSubscription = window.AKClientRuntimePushSubscription || {};
    window.AKClientRuntimePushSubscription.registerSubscription = registerSubscription;
})();
