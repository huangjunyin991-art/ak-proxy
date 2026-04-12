(function() {
    'use strict';

    if (window.AKNotificationAdminPanelLoaded) return;
    if (window.AKNotificationAdminPluginEntryLoaded) return;
    window.AKNotificationAdminPluginEntryLoaded = true;

    if (document.querySelector('script[data-ak-notification-admin-plugin-panel="1"]')) return;

    const script = document.createElement('script');
    script.src = `${window.location.origin}/admin/api/plugins/notification/admin/panel.js`;
    script.async = true;
    script.dataset.akNotificationAdminPluginPanel = '1';
    document.head.appendChild(script);
})();
