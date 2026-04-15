(function() {
    'use strict';

    if (window.AKIMClientLoaded) return;
    if (window.AKIMUserPluginEntryLoaded) return;
    window.AKIMUserPluginEntryLoaded = true;

    const widgetAssetVersion = String(window.__AK_WIDGET_ASSET_VERSION__ || '').trim();

    function withWidgetAssetVersion(url) {
        try {
            const finalUrl = new URL(String(url || ''), window.location.origin);
            if (widgetAssetVersion) finalUrl.searchParams.set('v', widgetAssetVersion);
            return finalUrl.toString();
        } catch (e) {
            return String(url || '');
        }
    }

    if (document.querySelector('script[data-ak-im-user-plugin-client="1"]')) return;

    const script = document.createElement('script');
    script.src = withWidgetAssetVersion(`${window.location.origin}/chat/plugins/im/user/im_client.js`);
    script.async = true;
    script.dataset.akImUserPluginClient = '1';
    document.head.appendChild(script);
})();
