(function() {
    'use strict';

    if (window.AKNotificationWidgetLoaded) return;
    if (window.AKNotificationUserPluginEntryLoaded) return;
    window.AKNotificationUserPluginEntryLoaded = true;

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

    if (document.querySelector('script[data-ak-notification-user-plugin-widget="1"]')) return;

    const script = document.createElement('script');
    script.src = withWidgetAssetVersion(`${window.location.origin}/chat/plugins/notification/user/widget.js`);
    script.async = true;
    script.dataset.akNotificationUserPluginWidget = '1';
    document.head.appendChild(script);
})();
