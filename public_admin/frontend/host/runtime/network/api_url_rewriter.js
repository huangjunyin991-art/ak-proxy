(function() {
    'use strict';

    function getProxyRpcBase() {
        return 'https://' + window.location.host + '/RPC/';
    }

    function rewriteApiUrl(url) {
        if (typeof url !== 'string') return url;
        if (url.indexOf('public_IndexData') !== -1) {
            return 'https://' + window.location.host + '/RPC/public_IndexData';
        }
        if (url.indexOf('akapi1.com') !== -1 || url.indexOf('akapi3.com') !== -1) {
            return url.replace(/https?:\/\/(www\.)?akapi[13]\.com\/RPC\//, getProxyRpcBase());
        }
        return url;
    }

    function fixApiUrl() {
        try {
            if (typeof APP !== 'undefined' && APP.CONFIG && APP.CONFIG.BASE_URL) {
                var oldUrl = APP.CONFIG.BASE_URL;
                if (oldUrl.indexOf('akapi1.com') !== -1 || oldUrl.indexOf('akapi3.com') !== -1) {
                    APP.CONFIG.BASE_URL = getProxyRpcBase();
                }
            }
        } catch(e) {}
    }

    window.AKClientRuntimeNetwork = window.AKClientRuntimeNetwork || {};
    window.AKClientRuntimeNetwork.fixApiUrl = fixApiUrl;
    window.AKClientRuntimeNetwork.rewriteApiUrl = rewriteApiUrl;
})();
