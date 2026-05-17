(function() {
    'use strict';

    function updateActivity() {
        if (window._akChatInitialized) {
            window._akLastActivity = Date.now();
        }
    }

    function rewriteApiUrl(url) {
        try {
            var network = window.AKClientRuntimeNetwork;
            if (network && typeof network.rewriteApiUrl === 'function') {
                return network.rewriteApiUrl(url);
            }
        } catch(e) {
        }
        return url;
    }

    function interceptNetworkRequests() {
        if (window.__AKChatNetworkInterceptorInstalled) return;
        window.__AKChatNetworkInterceptorInstalled = true;

        if (window.fetch) {
            var originalFetch = window.fetch;
            window.fetch = function(url, options) {
                updateActivity();
                var finalUrl = rewriteApiUrl(url);
                return originalFetch.call(this, finalUrl, options);
            };
        }

        if (window.XMLHttpRequest) {
            var originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                updateActivity();
                var finalUrl = rewriteApiUrl(url);
                return originalOpen.call(this, method, finalUrl, async, user, password);
            };
        }

        if (window.$ && window.$.ajaxPrefilter) {
            window.$.ajaxPrefilter(function(options, originalOptions, jqXHR) {
                if (options.url) {
                    options.url = rewriteApiUrl(options.url);
                }
            });
        }
    }

    window.AKClientRuntimeNetwork = window.AKClientRuntimeNetwork || {};
    window.AKClientRuntimeNetwork.interceptNetworkRequests = interceptNetworkRequests;
    window.AKClientRuntimeNetwork.updateActivity = updateActivity;
})();
