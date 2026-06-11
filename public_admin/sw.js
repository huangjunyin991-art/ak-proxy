(function() {
    'use strict';

    var VERSION = '20260611-ntfy-recovery-01';
    var CACHE_NAME = 'ak-notify-sw-state';
    var STATE_URL = '/__ak_notify_sw_state__';
    var SAFE_NOTIFICATION_ENTRY = '/pages/home.html?first=true';
    var SAFE_RECOVERY_ENTRY = '/pages/account/login.html';
    var SENSITIVE_QUERY_KEYS = {
        ak_im_open: true,
        im_switch_ts: true,
        im_switch_nonce: true,
        im_switch_sig: true,
        ts: true,
        nonce: true,
        sig: true
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function readState() {
        if (!self.caches) return Promise.resolve({});
        return caches.open(CACHE_NAME).then(function(cache) {
            return cache.match(STATE_URL);
        }).then(function(response) {
            if (!response) return {};
            return response.json().catch(function() { return {}; });
        }).catch(function() {
            return {};
        });
    }

    function writeState(patch) {
        if (!self.caches) return Promise.resolve(null);
        return readState().then(function(state) {
            var next = state && typeof state === 'object' ? state : {};
            Object.keys(patch || {}).forEach(function(key) {
                next[key] = patch[key];
            });
            next.version = VERSION;
            next.updated_at = nowIso();
            return caches.open(CACHE_NAME).then(function(cache) {
                return cache.put(STATE_URL, new Response(JSON.stringify(next), {
                    headers: {'Content-Type': 'application/json'}
                }));
            });
        }).catch(function() {
            return null;
        });
    }

    function clearForeignCaches() {
        if (!self.caches || !caches.keys) return Promise.resolve([]);
        return caches.keys().then(function(names) {
            return Promise.all(names.map(function(name) {
                if (name === CACHE_NAME) return Promise.resolve(false);
                return caches.delete(name);
            }));
        }).catch(function() {
            return [];
        });
    }

    function shouldRecoverClientUrl(value) {
        try {
            var parsed = new URL(String(value || ''), self.location.origin);
            if (parsed.origin !== self.location.origin) return false;
            var path = parsed.pathname || '/';
            return path === '/'
                || path === '/app'
                || path.indexOf('/app/') === 0
                || path === '/account'
                || path.indexOf('/account/') === 0
                || path === '/settings'
                || path.indexOf('/settings/') === 0
                || path === '/subscription'
                || path.indexOf('/subscription/') === 0
                || path === '/login'
                || path === '/signup';
        } catch(e) {
            return false;
        }
    }

    function recoverNtfyControlledClients() {
        if (!self.clients || !self.clients.matchAll) return Promise.resolve(null);
        return self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list) {
            return Promise.all(list.map(function(client) {
                try {
                    if (client && shouldRecoverClientUrl(client.url) && client.navigate) {
                        return client.navigate(new URL(SAFE_RECOVERY_ENTRY, self.location.origin).href);
                    }
                } catch(e) {
                }
                return null;
            }));
        }).catch(function() {
            return null;
        });
    }

    function parsePayload(event) {
        try {
            return event.data ? event.data.json() : {};
        } catch(e) {
            return {body: event.data ? event.data.text() : ''};
        }
    }

    function isSensitiveQueryKey(key) {
        return !!SENSITIVE_QUERY_KEYS[String(key || '').trim().toLowerCase()];
    }

    function redactUrlForState(url) {
        try {
            var parsed = url && url.href ? new URL(url.href) : new URL(String(url || SAFE_NOTIFICATION_ENTRY), self.location.origin);
            if (parsed.origin !== self.location.origin) return '[external-blocked]';
            var keys = [];
            parsed.searchParams.forEach(function(_value, key) {
                if (isSensitiveQueryKey(key)) keys.push(key);
            });
            for (var i = 0; i < keys.length; i++) {
                parsed.searchParams.set(keys[i], 'redacted');
            }
            return (parsed.pathname || '/') + (parsed.search || '') + (parsed.hash || '');
        } catch(e) {
            return SAFE_NOTIFICATION_ENTRY;
        }
    }

    function buildSafeNavigation(target) {
        var fallback = new URL(SAFE_NOTIFICATION_ENTRY, self.location.origin);
        try {
            var parsed = new URL(String(target || SAFE_NOTIFICATION_ENTRY), self.location.origin);
            if (parsed.origin !== self.location.origin) {
                return {url: fallback, blockedExternal: true};
            }
            return {url: parsed, blockedExternal: false};
        } catch(e) {
            return {url: fallback, blockedExternal: true};
        }
    }

    function toRelativeUrl(url) {
        try {
            return (url.pathname || '/') + (url.search || '') + (url.hash || '');
        } catch(e) {
            return SAFE_NOTIFICATION_ENTRY;
        }
    }

    self.addEventListener('install', function() {
        if (self.skipWaiting) self.skipWaiting();
    });

    self.addEventListener('activate', function(event) {
        var task = clearForeignCaches().then(function() {
            return writeState({
                activated_at: nowIso(),
                recovered_foreign_sw_caches: true
            });
        }).then(function() {
            if (self.clients && self.clients.claim) return self.clients.claim();
            return null;
        }).then(function() {
            return recoverNtfyControlledClients();
        });
        if (event && event.waitUntil) event.waitUntil(task);
    });

    self.addEventListener('push', function(event) {
        var payload = parsePayload(event);
        var safeNavigation = buildSafeNavigation(payload.url || SAFE_NOTIFICATION_ENTRY);
        var title = payload.title || '有新消息';
        var options = {
            body: payload.body || '点击查看',
            icon: '/admin/api/pwa-icon/192',
            badge: '/admin/api/pwa-icon/192',
            tag: payload.tag || 'ak-notify',
            renotify: true,
            data: {
                url: toRelativeUrl(safeNavigation.url),
                event_id: payload.data && payload.data.event_id || '',
                conversation_id: payload.data && payload.data.conversation_id || 0
            }
        };
        var task = writeState({
            last_push_at: nowIso(),
            last_push_title: title,
            last_push_body: options.body,
            last_push_tag: options.tag,
            last_push_event_id: options.data.event_id,
            last_push_conversation_id: options.data.conversation_id,
            last_push_url: redactUrlForState(safeNavigation.url),
            last_push_url_blocked_external: safeNavigation.blockedExternal,
            last_show_notification_called: false,
            last_show_notification_ok: false,
            last_show_notification_error: ''
        }).then(function() {
            if (!self.registration || !self.registration.showNotification) {
                return writeState({last_show_notification_error: 'showNotification unavailable'});
            }
            return self.registration.showNotification(title, options).then(function() {
                return writeState({
                    last_show_notification_called: true,
                    last_show_notification_ok: true,
                    last_show_notification_at: nowIso(),
                    last_show_notification_error: ''
                });
            }).catch(function(error) {
                return writeState({
                    last_show_notification_called: true,
                    last_show_notification_ok: false,
                    last_show_notification_error: error && error.message ? String(error.message) : 'showNotification failed'
                });
            });
        });
        if (event && event.waitUntil) event.waitUntil(task);
    });

    self.addEventListener('notificationclick', function(event) {
        if (event.notification) event.notification.close();
        var target = event.notification && event.notification.data && event.notification.data.url || '/';
        var safeNavigation = buildSafeNavigation(target);
        var targetUrl = safeNavigation.url.href;
        var task = writeState({
            last_notification_click_at: nowIso(),
            last_notification_click_url: redactUrlForState(safeNavigation.url),
            last_notification_click_blocked_external: safeNavigation.blockedExternal
        }).then(function() {
            if (!self.clients) return null;
            return self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list) {
                for (var i = 0; i < list.length; i++) {
                    var client = list[i];
                    try {
                        if (client.url && new URL(client.url).origin === self.location.origin) {
                            if (client.focus) client.focus();
                            if (client.navigate) return client.navigate(targetUrl);
                            return null;
                        }
                    } catch(e) {
                    }
                }
                if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
                return null;
            });
        });
        if (event && event.waitUntil) event.waitUntil(task);
    });

    self.addEventListener('message', function(event) {
        var data = event && event.data || {};
        if (!data || data.type !== 'AK_NOTIFY_SW_DIAGNOSTICS') return;
        readState().then(function(state) {
            var result = state && typeof state === 'object' ? state : {};
            result.version = result.version || VERSION;
            result.script_url = self.location && self.location.href || '';
            if (event.ports && event.ports[0]) event.ports[0].postMessage(result);
        });
    });
})();
