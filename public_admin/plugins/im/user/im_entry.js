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

    const assets = [
        {
            selector: 'script[data-ak-im-user-plugin-profile="1"]',
            datasetKey: 'akImUserPluginProfile',
            src: `${window.location.origin}/chat/plugins/im/user/modules/im_profile.js`
        },
        {
            selector: 'script[data-ak-im-user-plugin-session-manage="1"]',
            datasetKey: 'akImUserPluginSessionManage',
            src: `${window.location.origin}/chat/plugins/im/user/modules/im_session_manage.js`
        },
        {
            selector: 'script[data-ak-im-user-plugin-group-manage="1"]',
            datasetKey: 'akImUserPluginGroupManage',
            src: `${window.location.origin}/chat/plugins/im/user/modules/im_group_manage.js`
        },
        {
            selector: 'script[data-ak-im-user-plugin-message-manage="1"]',
            datasetKey: 'akImUserPluginMessageManage',
            src: `${window.location.origin}/chat/plugins/im/user/modules/im_message_manage.js`
        },
        {
            selector: 'script[data-ak-im-user-plugin-overlay="1"]',
            datasetKey: 'akImUserPluginOverlay',
            src: `${window.location.origin}/chat/plugins/im/user/modules/im_overlay.js`
        },
        {
            selector: 'script[data-ak-im-user-plugin-app-shell="1"]',
            datasetKey: 'akImUserPluginAppShell',
            src: `${window.location.origin}/chat/plugins/im/user/modules/im_app_shell.js`
        },
        {
            selector: 'script[data-ak-im-user-plugin-client="1"]',
            datasetKey: 'akImUserPluginClient',
            src: `${window.location.origin}/chat/plugins/im/user/im_client.js`
        }
    ];

    function loadAsset(index) {
        if (index >= assets.length) return;
        const asset = assets[index];
        if (document.querySelector(asset.selector)) {
            loadAsset(index + 1);
            return;
        }
        const script = document.createElement('script');
        script.src = withWidgetAssetVersion(asset.src);
        script.async = false;
        script.dataset[asset.datasetKey] = '1';
        const continueLoad = function() {
            script.onload = null;
            script.onerror = null;
            loadAsset(index + 1);
        };
        script.onload = continueLoad;
        script.onerror = continueLoad;
        document.head.appendChild(script);
    }

    loadAsset(0);
})();
