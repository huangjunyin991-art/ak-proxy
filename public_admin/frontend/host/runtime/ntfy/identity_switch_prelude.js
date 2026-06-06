(function() {
    'use strict';

    var MAX_RUNTIME_WAIT_MS = 8500;
    var MAX_INDEXDATA_WAIT_MS = 9000;
    var APP_PATCH_INTERVAL_MS = 50;
    var APP_PATCH_MAX_MS = 12000;
    var COOKIE_MAX_AGE = String(86400 * 30);

    function getQuery() {
        try {
            return new URLSearchParams(String(window.location.search || ''));
        } catch (e) {
            return null;
        }
    }

    var query = getQuery();
    if (!query) return;

    var targetUsername = String(query.get('im_username') || '').trim().toLowerCase();
    var openFlag = String(query.get('ak_im_open') || '').trim().toLowerCase();
    var hasSignedToken = !!(
        query.get('im_switch_ts') &&
        query.get('im_switch_nonce') &&
        query.get('im_switch_sig')
    );

    if (!targetUsername || (openFlag !== '1' && openFlag !== 'true')) return;

    var switchDone = false;
    var switchResult = null;
    var switchPromise = null;
    var appPatchTimer = null;
    var appPatchStartedAt = Date.now();

    function debug(step, extra) {
        try {
            var data = window.__AK_NTFY_SWITCH_DEBUG__ || {};
            data.ts = data.ts || Date.now();
            data.step = step;
            data.im_username = targetUsername;
            if (extra && typeof extra === 'object') {
                for (var key in extra) {
                    if (Object.prototype.hasOwnProperty.call(extra, key)) data[key] = extra[key];
                }
            }
            window.__AK_NTFY_SWITCH_DEBUG__ = data;
        } catch (e) {}
    }

    function getLock() {
        try {
            return window.__AK_NTFY_IDENTITY_LOCK__ || null;
        } catch (e) {
            return null;
        }
    }

    function updateLock(patch) {
        try {
            var current = getLock() || {};
            for (var key in patch) {
                if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = patch[key];
            }
            current.username = targetUsername;
            current.targetUsername = targetUsername;
            current.updatedAt = Date.now();
            window.__AK_NTFY_IDENTITY_LOCK__ = current;
            return current;
        } catch (e) {
            return null;
        }
    }

    function setCookie(name, value) {
        try {
            document.cookie = name + '=' + encodeURIComponent(value || '') + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax; Secure';
        } catch (e) {
            try {
                document.cookie = name + '=' + encodeURIComponent(value || '') + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax';
            } catch (e2) {}
        }
    }

    function clearCookie(name) {
        var key = String(name || '').trim();
        if (!key) return;
        var host = '';
        try {
            host = String(window.location.hostname || '').trim();
        } catch (e) {}
        var domains = [''];
        if (host && host.indexOf('.') !== -1) {
            domains.push(host);
            domains.push('.' + host.replace(/^\./, ''));
        }
        var paths = ['/', '/admin', '/pages', '/pages/account'];
        for (var i = 0; i < domains.length; i++) {
            var domainPart = domains[i] ? '; domain=' + domains[i] : '';
            for (var j = 0; j < paths.length; j++) {
                var pathPart = '; path=' + paths[j];
                try { document.cookie = key + '=' + pathPart + '; max-age=0; SameSite=Lax' + domainPart; } catch (e2) {}
                try { document.cookie = key + '=' + pathPart + '; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax' + domainPart; } catch (e3) {}
                try { document.cookie = key + '=' + pathPart + '; max-age=0; SameSite=Lax; Secure' + domainPart; } catch (e4) {}
            }
        }
    }

    function writeStorage(store, key, value) {
        try {
            if (store && key) store.setItem(key, value);
        } catch (e) {}
    }

    function cloneObject(source) {
        var target = {};
        if (!source || typeof source !== 'object') return target;
        for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
        }
        return target;
    }

    function pickUsername(source) {
        if (!source || typeof source !== 'object') return '';
        var keys = ['UserName', 'Username', 'userName', 'username', 'Account', 'account', 'LoginName', 'loginName'];
        for (var i = 0; i < keys.length; i++) {
            if (source[keys[i]] != null && source[keys[i]] !== '') return String(source[keys[i]]).trim().toLowerCase();
        }
        return '';
    }

    function readJsonStorage(store, key) {
        try {
            var raw = store && key ? store.getItem(key) : '';
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {}
        return null;
    }

    function readCookie(name) {
        try {
            var escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
            return match ? decodeURIComponent(match[1] || '').trim().toLowerCase() : '';
        } catch (e) {}
        return '';
    }

    function readCurrentUsername() {
        try {
            var runtimeUser = pickUsername(window.APP && APP.USER && APP.USER.MODEL);
            if (runtimeUser) return runtimeUser;
        } catch (e) {}
        try {
            var globalUser = pickUsername(window.USER_MODEL);
            if (globalUser) return globalUser;
        } catch (e2) {}
        try {
            var keys = [getStoreKey(), 'AK_user_model', 'UserData', 'ak_login_result'];
            for (var i = 0; i < keys.length; i++) {
                var parsed = readJsonStorage(localStorage, keys[i]);
                if (keys[i] === 'ak_login_result' && parsed && parsed.UserData) parsed = parsed.UserData;
                var username = pickUsername(parsed);
                if (username) return username;
            }
        } catch (e3) {}
        try {
            var sessionKeys = ['UserData', 'ak_login_result'];
            for (var j = 0; j < sessionKeys.length; j++) {
                var sessionParsed = readJsonStorage(sessionStorage, sessionKeys[j]);
                if (sessionKeys[j] === 'ak_login_result' && sessionParsed && sessionParsed.UserData) sessionParsed = sessionParsed.UserData;
                var sessionUsername = pickUsername(sessionParsed);
                if (sessionUsername) return sessionUsername;
            }
        } catch (e4) {}
        return readCookie('ak_username') || readCookie('ak_im_username');
    }

    function isTokenTerminalFailure(reason, status) {
        var normalized = String(reason || '').trim().toLowerCase();
        var terminal = {
            already_used: 1,
            invalid_signature: 1,
            invalid_timestamp: 1,
            invalid_token: 1,
            missing_signature: 1,
            token_expired: 1,
            token_from_future: 1
        };
        if (terminal[normalized]) return true;
        return Number(status || 0) === 401 && normalized && normalized.indexOf('token') !== -1;
    }

    function clearAkLoginStateForRelogin() {
        var storageKeys = [
            'AK_user_model',
            getStoreKey(),
            'userkey',
            'UserKey',
            '_ak_sl',
            'ak_login_result',
            'UserData',
            'AK_local_login_info',
            'ak_ntfy_im_username',
            'ak_ntfy_force_login',
            'ak_im_sync_key_' + targetUsername
        ];
        for (var i = 0; i < storageKeys.length; i++) {
            try { localStorage.removeItem(storageKeys[i]); } catch (e) {}
            try { sessionStorage.removeItem(storageKeys[i]); } catch (e2) {}
        }
        try {
            for (var li = localStorage.length - 1; li >= 0; li--) {
                var localKey = String(localStorage.key(li) || '');
                if (localKey.indexOf('ak_im_sync_key_') === 0 || localKey.indexOf('ak.im.bootstrap.v1:') === 0) {
                    localStorage.removeItem(localKey);
                }
            }
        } catch (e3) {}
        try {
            for (var si = sessionStorage.length - 1; si >= 0; si--) {
                var sessionKey = String(sessionStorage.key(si) || '');
                if (sessionKey.indexOf('ak_im_sync_key_') === 0 || sessionKey.indexOf('ak.im.bootstrap.v1:') === 0) {
                    sessionStorage.removeItem(sessionKey);
                }
            }
        } catch (e4) {}
        clearCookie('ak_username');
        clearCookie('ak_im_username');
        clearCookie('ak_persist');
        clearCookie('ak_admin_bs');
        try { window.AKIMClientUsername = ''; } catch (e5) {}
        try { window.userkey = ''; } catch (e8) {}
        try { window.USER_MODEL = { Id: 0, Key: '' }; } catch (e6) {}
        try {
            if (window.APP && APP.USER) APP.USER.MODEL = { Id: 0, Key: '' };
        } catch (e7) {}
    }

    function redirectToLoginForTokenFailure(reason) {
        var loginUrl = '/admin/api/ak_auth/ntfy_force_login?reason='
            + encodeURIComponent(String(reason || 'ntfy_token_invalid'))
            + '&im_username=' + encodeURIComponent(targetUsername);
        updateLock({
            active: false,
            pending: false,
            failed: true,
            redirecting: true,
            reason: String(reason || 'ntfy_token_invalid')
        });
        debug('token-failure-redirect-login', { reason: String(reason || ''), currentUsername: readCurrentUsername() });
        try {
            sessionStorage.setItem('ak_ntfy_force_login', JSON.stringify({
                im_username: targetUsername,
                reason: String(reason || 'ntfy_token_invalid'),
                at: Date.now()
            }));
        } catch (e2) {}
        try {
            window.location.replace(loginUrl);
        } catch (e) {
            window.location.href = loginUrl;
        }
    }

    function maybeRedirectToLoginOnTokenFailure(result) {
        result = result || {};
        var reason = String(result.reason || '').trim();
        if (!isTokenTerminalFailure(reason, result.status)) return false;
        var currentUsername = readCurrentUsername();
        debug('token-failure-check-current', {
            reason: reason,
            status: Number(result.status || 0),
            currentUsername: currentUsername
        });
        if (currentUsername && currentUsername === targetUsername) return false;
        clearAkLoginStateForRelogin();
        redirectToLoginForTokenFailure(reason || 'ntfy_token_invalid');
        return true;
    }

    function getStoreKey() {
        try {
            if (window.APP && APP.CONFIG && APP.CONFIG.SYSTEM_KEYS && APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY) {
                return APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY;
            }
        } catch (e) {}
        return 'AK_user_model';
    }

    function buildModel(snapshot) {
        var model = cloneObject(snapshot && snapshot.userModel);
        var result = snapshot && snapshot.loginResult;
        if (!Object.keys(model).length && result && typeof result.UserData === 'object') {
            model = cloneObject(result.UserData);
        }
        model.UserName = targetUsername;
        model.Key = String((snapshot && snapshot.userkey) || model.Key || '');
        return model;
    }

    function readStoredTargetModel() {
        try {
            var keys = [getStoreKey(), 'AK_user_model'];
            for (var i = 0; i < keys.length; i++) {
                var raw = localStorage.getItem(keys[i]);
                if (!raw) continue;
                var parsed = JSON.parse(raw);
                if (pickUsername(parsed) === targetUsername && (parsed.Key || parsed.key)) return parsed;
            }
        } catch (e) {}
        return {};
    }

    function refreshAppModel() {
        var model = readStoredTargetModel();
        if (!model || typeof model !== 'object' || !(model.Key || model.key || model.Id || model.id)) return {};
        try {
            window.USER_MODEL = model;
            window.userkey = String(model.Key || model.key || '');
            if (window.APP) {
                APP.USER = APP.USER || {};
                APP.USER.MODEL = model;
            }
            window.AKIMClientUsername = targetUsername;
        } catch (e) {}
        return model;
    }

    function applyInline(snapshot) {
        if (!snapshot || !snapshot.userkey) return false;
        var model = buildModel(snapshot);
        if (!model.Key) return false;
        var loginResult = cloneObject(snapshot.loginResult);
        var userData = cloneObject(loginResult.UserData || model);
        userData.UserName = targetUsername;
        loginResult.UserData = userData;
        loginResult.Key = model.Key;
        if (loginResult.Error == null) loginResult.Error = false;

        var modelText = JSON.stringify(model);
        var loginResultText = JSON.stringify(loginResult);
        var userDataText = JSON.stringify(userData);
        var storeKey = getStoreKey();
        writeStorage(localStorage, 'AK_user_model', modelText);
        writeStorage(localStorage, storeKey, modelText);
        writeStorage(localStorage, 'userkey', model.Key);
        writeStorage(localStorage, 'UserKey', model.Key);
        writeStorage(localStorage, 'ak_login_result', loginResultText);
        writeStorage(localStorage, 'UserData', userDataText);
        writeStorage(localStorage, 'ak_im_sync_key_' + targetUsername, model.Key);
        writeStorage(sessionStorage, 'ak_login_result', loginResultText);
        writeStorage(sessionStorage, 'UserData', userDataText);
        writeStorage(sessionStorage, 'ak_ntfy_im_username', targetUsername);
        setCookie('ak_username', targetUsername);
        setCookie('ak_im_username', targetUsername);
        refreshAppModel();
        return true;
    }

    function applySnapshot(snapshot) {
        snapshot = snapshot || {};
        snapshot.username = String(snapshot.username || targetUsername).trim().toLowerCase();
        if (snapshot.username !== targetUsername || !snapshot.userkey) return false;
        window.__AK_PENDING_IDENTITY_SWITCH__ = snapshot;
        var auth = window.AKClientRuntimeAuth;
        if (auth && typeof auth.applyIdentitySnapshot === 'function') {
            var result = auth.applyIdentitySnapshot(snapshot, { source: 'ntfy-prelude' });
            if (result === true || (result && result.applied)) {
                return true;
            }
        }
        var applied = applyInline(snapshot);
        if (applied) {
            try {
                window.dispatchEvent(new CustomEvent('ak:identity-switched', {
                    detail: { username: targetUsername, source: 'ntfy-prelude-inline' }
                }));
            } catch (e) {}
        }
        return applied;
    }

    function buildApiUrl() {
        return '/admin/api/ak_auth/silent_login_by_token?u=' + encodeURIComponent(targetUsername)
            + '&conversation_id=' + encodeURIComponent(String(query.get('conversation_id') || ''))
            + '&im_switch_ts=' + encodeURIComponent(String(query.get('im_switch_ts') || ''))
            + '&im_switch_nonce=' + encodeURIComponent(String(query.get('im_switch_nonce') || ''))
            + '&im_switch_sig=' + encodeURIComponent(String(query.get('im_switch_sig') || ''));
    }

    function finish(result) {
        switchDone = true;
        switchResult = result || { synced: false, reason: 'unknown' };
        if (maybeRedirectToLoginOnTokenFailure(switchResult)) {
            switchResult.redirecting = true;
        }
        updateLock({
            pending: false,
            active: !!switchResult.synced,
            synced: !!switchResult.synced,
            failed: !switchResult.synced,
            reason: switchResult.reason || '',
            userId: switchResult.userId || ''
        });
        debug('switch-finish', switchResult);
        return switchResult;
    }

    function startSwitch() {
        if (switchPromise) return switchPromise;
        if (switchDone) return Promise.resolve(switchResult);
        updateLock({
            active: true,
            pending: true,
            synced: false,
            failed: false,
            startedAt: Date.now()
        });
        try {
            sessionStorage.setItem('ak_ntfy_im_username', targetUsername);
        } catch (e) {}
        if (!hasSignedToken) {
            debug('api-missing-signature', {});
            switchPromise = Promise.resolve(finish({
                synced: false,
                reason: 'missing_signature',
                username: targetUsername,
                status: 401
            }));
            window.__AK_NTFY_SWITCH_PROMISE__ = switchPromise;
            return switchPromise;
        }
        switchPromise = new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            var url = buildApiUrl();
            debug('api-prep', { apiUrl: url });
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
            xhr.onload = function() {
                var response = null;
                var applied = false;
                try {
                    response = JSON.parse(xhr.responseText || '{}');
                } catch (e) {}
                debug('api-onload', {
                    status: xhr.status || 0,
                    rOk: !!(response && response.success),
                    code: response && response.code ? String(response.code) : '',
                    rKeyMasked: response && response.userkeyMasked ? String(response.userkeyMasked) : ''
                });
                if (xhr.status === 200 && response && response.success && response.userkey) {
                    applied = applySnapshot(response);
                }
                if (applied) {
                    debug('applied-snapshot', { username: targetUsername, userId: response && response.userId ? response.userId : '' });
                    resolve(finish({
                        synced: true,
                        reason: 'silent_login_ok',
                        username: targetUsername,
                        userId: response && response.userId ? response.userId : ''
                    }));
                    return;
                }
                resolve(finish({
                    synced: false,
                    reason: (response && response.code) || 'silent_login_failed',
                    username: targetUsername,
                    status: xhr.status || 0
                }));
            };
            xhr.onerror = function() {
                debug('api-error', {});
                resolve(finish({ synced: false, reason: 'network_error', username: targetUsername, status: xhr.status || 0 }));
            };
            try {
                xhr.send('{}');
            } catch (e) {
                resolve(finish({ synced: false, reason: 'send_exception', username: targetUsername }));
            }
        });
        window.__AK_NTFY_SWITCH_PROMISE__ = switchPromise;
        return switchPromise;
    }

    function waitWithTimeout(promise, timeoutMs) {
        var timeout = Math.max(500, Number(timeoutMs || 0) || MAX_RUNTIME_WAIT_MS);
        return new Promise(function(resolve) {
            var done = false;
            var timer = setTimeout(function() {
                if (done) return;
                done = true;
                debug('wait-timeout', { timeoutMs: timeout });
                resolve({ synced: false, reason: 'timeout', username: targetUsername });
            }, timeout);
            promise.then(function(result) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(result || { synced: false, reason: 'empty_result', username: targetUsername });
            }).catch(function() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ synced: false, reason: 'promise_error', username: targetUsername });
            });
        });
    }

    function patchIndexDataBody(body) {
        try {
            if (typeof body !== 'string') return body;
            var model = refreshAppModel();
            var key = String(model.Key || model.key || '').trim();
            var userId = String(model.Id || model.ID || model.id || '').trim();
            if (!key && !userId) return body;
            var params = new URLSearchParams(body);
            if (key) params.set('key', key);
            if (userId) params.set('UserID', userId);
            return params.toString();
        } catch (e) {
            return body;
        }
    }

    function installHomeSyncHook() {
        try {
            window.__AKChatSyncUserModel = function(callback) {
                waitWithTimeout(startSwitch(), MAX_INDEXDATA_WAIT_MS).then(function(result) {
                    refreshAppModel();
                    try {
                        if (callback) callback(result || { synced: false, reason: 'empty_result' });
                    } catch (e) {}
                });
            };
            window.__AKChatSyncUserModel.__akNtfySwitchHook = 1;
            debug('home-sync-hook-installed', {});
        } catch (e) {}
    }

    function installIndexDataGate() {
        try {
            if (window.__AK_NTFY_INDEXDATA_GATE__) return;
            window.__AK_NTFY_INDEXDATA_GATE__ = 1;
            var nativeOpen = XMLHttpRequest.prototype.open;
            var nativeSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {
                try {
                    this.__akNtfyGateIndexData = String(url || '').indexOf('public_IndexData') !== -1;
                } catch (e) {}
                return nativeOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function(body) {
                if (this.__akNtfyGateIndexData) {
                    var xhr = this;
                    debug('indexdata-gate-wait', {});
                    waitWithTimeout(startSwitch(), MAX_INDEXDATA_WAIT_MS).then(function(result) {
                        refreshAppModel();
                        debug('indexdata-gate-send', { reason: result && result.reason ? result.reason : '' });
                        nativeSend.call(xhr, patchIndexDataBody(body));
                    }).catch(function() {
                        debug('indexdata-gate-fallback', {});
                        nativeSend.call(xhr, body);
                    });
                    return;
                }
                return nativeSend.apply(this, arguments);
            };
            debug('indexdata-gate-installed', {});
        } catch (e) {}
    }

    function installAppPatchWatchdog() {
        function patch() {
            try {
                if (!window.APP || !APP.GLOBAL) return false;
                if (typeof APP.GLOBAL.getUserModel === 'function' && !APP.GLOBAL.getUserModel.__akNtfyIdentityWrapped) {
                    var originalGetUserModel = APP.GLOBAL.getUserModel;
                    var wrappedGetUserModel = function() {
                        var model = refreshAppModel();
                        if (model && (model.Key || model.key)) return model;
                        return originalGetUserModel.apply(this, arguments);
                    };
                    wrappedGetUserModel.__akNtfyIdentityWrapped = 1;
                    APP.GLOBAL.getUserModel = wrappedGetUserModel;
                }
                if (typeof APP.GLOBAL.ajax === 'function' && !APP.GLOBAL.ajax.__akNtfyIdentityWrapped) {
                    var originalAjax = APP.GLOBAL.ajax;
                    var wrappedAjax = function(option) {
                        try {
                            if (option && typeof option === 'object' && String(option.url || '').indexOf('public_IndexData') !== -1) {
                                var model = refreshAppModel();
                                var key = String(model.Key || model.key || '').trim();
                                var userId = String(model.Id || model.ID || model.id || '').trim();
                                option.data = option.data || {};
                                if (key) option.data.key = key;
                                if (userId) option.data.UserID = userId;
                            }
                        } catch (e) {}
                        return originalAjax.apply(this, arguments);
                    };
                    wrappedAjax.__akNtfyIdentityWrapped = 1;
                    APP.GLOBAL.ajax = wrappedAjax;
                }
                refreshAppModel();
                debug('app-patch-installed', {});
                return true;
            } catch (e) {
                return false;
            }
        }
        if (patch()) return;
        appPatchTimer = setInterval(function() {
            if (patch() || Date.now() - appPatchStartedAt > APP_PATCH_MAX_MS) {
                clearInterval(appPatchTimer);
                appPatchTimer = null;
            }
        }, APP_PATCH_INTERVAL_MS);
    }

    window.__AKWaitForNtfyIdentitySwitch = function(options) {
        options = options || {};
        return waitWithTimeout(startSwitch(), Number(options.timeoutMs || 0) || MAX_RUNTIME_WAIT_MS);
    };

    updateLock({ active: true, pending: true, synced: false, failed: false, startedAt: Date.now() });
    installHomeSyncHook();
    installIndexDataGate();
    installAppPatchWatchdog();
    startSwitch();
})();
