(function() {
    'use strict';

    function getVersionedAssetUrl(url) {
        try {
            var context = window.AKClientRuntimeContext;
            if (context && typeof context.withWidgetAssetVersion === 'function') {
                return context.withWidgetAssetVersion(url);
            }
        } catch(e) {
        }
        return String(url || '');
    }

    function isLoginPage() {
        try {
            return window.location.pathname.toLowerCase().indexOf('/login') !== -1;
        } catch(e) {
            return false;
        }
    }

    function ensureNotificationWidget() {
        try {
            var root = document.getElementById('ak-notification-widget-root');
            if (root && root.parentNode) root.parentNode.removeChild(root);
            var style = document.getElementById('ak-notification-widget-style');
            if (style && style.parentNode) style.parentNode.removeChild(style);
        } catch(e) {}
    }

    function syncIMPluginVisibility() {
        try {
            var root = document.getElementById('ak-im-root');
            if (!root) return;
            if (isLoginPage()) {
                root.classList.remove('ak-visible');
                root.classList.remove('ak-im-open');
                root.style.display = 'none';
            } else {
                root.style.display = '';
            }
        } catch(e) {}
    }

    function ensureIMUsernameCookie() {
        try {
            var auth = window.AKClientRuntimeAuth;
            if (auth && typeof auth.ensureIMUsernameCookieFromUserModel === 'function') {
                return auth.ensureIMUsernameCookieFromUserModel();
            }
        } catch(e) {}
        return false;
    }

    function ensureIMPlugin() {
        try {
            ensureIMUsernameCookie();
            if (isLoginPage()) {
                syncIMPluginVisibility();
                return;
            }
            if (window.AKIMClientLoaded) return;
            if (document.querySelector('script[data-ak-im-plugin-entry="1"]')) return;
            setTimeout(ensureIMUsernameCookie, 300);
            setTimeout(ensureIMUsernameCookie, 1200);
            var script = document.createElement('script');
            script.src = getVersionedAssetUrl(window.location.origin + '/chat/plugins/im/user/im_entry.js');
            script.async = true;
            script.dataset.akImPluginEntry = '1';
            document.head.appendChild(script);
        } catch(e) {}
    }

    function bootHomePlugins() {
        ensureNotificationWidget();
        ensureIMPlugin();
        syncIMPluginVisibility();
    }

    function refreshHomePlugins() {
        ensureIMPlugin();
        syncIMPluginVisibility();
    }

    window.AKClientRuntimeIM = window.AKClientRuntimeIM || {};
    window.AKClientRuntimeIM.bootHomePlugins = bootHomePlugins;
    window.AKClientRuntimeIM.refreshHomePlugins = refreshHomePlugins;
})();
