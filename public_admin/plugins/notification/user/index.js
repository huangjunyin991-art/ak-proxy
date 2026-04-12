(function() {
    'use strict';

    if (window.AKNotificationWidgetLoaded) return;
    if (window.AKNotificationUserPluginEntryLoaded) return;
    window.AKNotificationUserPluginEntryLoaded = true;

    if (document.querySelector('script[data-ak-notification-user-plugin-widget="1"]')) return;

    const script = document.createElement('script');
    script.src = `${window.location.origin}/chat/plugins/notification/user/widget.js`;
    script.async = true;
    script.dataset.akNotificationUserPluginWidget = '1';
    document.head.appendChild(script);
})();
