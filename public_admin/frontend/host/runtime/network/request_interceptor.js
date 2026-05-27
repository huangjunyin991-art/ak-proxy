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

    function isLoginUrl(url) {
        try {
            var parsed = new URL(String(url || ''), window.location.href);
            return (parsed.pathname || '').toLowerCase().indexOf('/rpc/login') !== -1;
        } catch(e) {
            return String(url || '').toLowerCase().indexOf('/rpc/login') !== -1;
        }
    }

    function showNotFoundPage() {
        if (window.__AKRiskIsolationNotFoundShown) return;
        window.__AKRiskIsolationNotFoundShown = true;
        try {
            window.history.replaceState(null, '', '/404');
        } catch(e) {
        }
        try {
            document.open();
            document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>');
            document.close();
        } catch(e2) {
            window.location.replace('/404');
        }
    }

    function interceptNetworkRequests() {
        if (window.__AKChatNetworkInterceptorInstalled) return;
        window.__AKChatNetworkInterceptorInstalled = true;

        if (window.fetch) {
            var originalFetch = window.fetch;
            window.fetch = function(url, options) {
                updateActivity();
                var finalUrl = rewriteApiUrl(url);
                var loginRequest = isLoginUrl(finalUrl);
                var result = originalFetch.call(this, finalUrl, options);
                if (loginRequest) {
                    result.then(function(response) {
                        if (response && response.status === 404) showNotFoundPage();
                    }).catch(function() {});
                }
                return result;
            };
        }

        if (window.XMLHttpRequest) {
            var originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                updateActivity();
                var finalUrl = rewriteApiUrl(url);
                this.__akRuntimeLoginRequest = isLoginUrl(finalUrl);
                this.addEventListener('load', function() {
                    try {
                        if (this.__akRuntimeLoginRequest && this.status === 404) showNotFoundPage();
                    } catch(e) {
                    }
                });
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
