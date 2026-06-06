(function() {
    'use strict';

    var MAX_RUNTIME_WAIT_MS = 8500;
    var MAX_INDEXDATA_WAIT_MS = 9000;
    var APP_PATCH_INTERVAL_MS = 50;
    var APP_PATCH_MAX_MS = 12000;
    var LOGIN_GOTO_WAIT_MS = 3000;
    var LOGIN_GOTO_POLL_MS = 50;
    var LOGIN_GOTO_FALLBACK_MS = 800;
    var COOKIE_MAX_AGE = String(86400 * 30);

    function writeEarlyDebug(step, extra) {
        try {
            var data = window.__AK_NTFY_SWITCH_DEBUG__ || {};
            data.ts = data.ts || Date.now();
            data.step = step;
            if (extra && typeof extra === 'object') {
                for (var key in extra) {
                    if (Object.prototype.hasOwnProperty.call(extra, key)) data[key] = extra[key];
                }
            }
            window.__AK_NTFY_SWITCH_DEBUG__ = data;
        } catch (e) {}
    }

    function parseSearchParams(search) {
        try {
            return new URLSearchParams(String(search || ''));
        } catch (e) {
            return null;
        }
    }

    function getLoaderReferrerSearch() {
        try {
            var referrer = String(window.__AK_NTFY_LOADER_REFERRER__ || '').trim();
            if (!referrer) return '';
            return new URL(referrer, window.location.href).search || '';
        } catch (e) {}
        return '';
    }

    function getQuery() {
        try {
            var query = parseSearchParams(window.location.search);
            var referrerSearch = getLoaderReferrerSearch();
            var fallback = parseSearchParams(referrerSearch);
            if (!query && !fallback) return null;
            if (!query) query = parseSearchParams('');
            if (fallback && typeof fallback.forEach === 'function') {
                fallback.forEach(function(value, key) {
                    if (!query.has(key)) query.set(key, value);
                });
            }
            return query;
        } catch (e) {
            return null;
        }
    }

    var query = getQuery();
    if (!query) {
        writeEarlyDebug('skip-query-unavailable', {
            locationSearch: String(window.location.search || ''),
            loaderReferrer: String(window.__AK_NTFY_LOADER_REFERRER__ || '')
        });
        return;
    }

    var targetUsername = String(query.get('im_username') || '').trim().toLowerCase();
    var openFlag = String(query.get('ak_im_open') || '').trim().toLowerCase();
    var reasonFlag = String(query.get('reason') || '').trim().toLowerCase();
    var isOpenRequest = openFlag === '1' || openFlag === 'true';
    var isForceLoginCleanup = !!targetUsername && !isOpenRequest && (
        reasonFlag.indexOf('ntfy') !== -1 ||
        reasonFlag.indexOf('token') !== -1 ||
        reasonFlag.indexOf('signature') !== -1 ||
        reasonFlag === 'already_used' ||
        reasonFlag === 'missing_signature'
    );
    var hasSignedToken = !!(
        query.get('im_switch_ts') &&
        query.get('im_switch_nonce') &&
        query.get('im_switch_sig')
    );

    if (!targetUsername || (!isOpenRequest && !isForceLoginCleanup)) {
        writeEarlyDebug('skip-no-ntfy-open-request', {
            targetUsername: targetUsername,
            openFlag: openFlag,
            reasonFlag: reasonFlag,
            locationSearch: String(window.location.search || ''),
            loaderReferrer: String(window.__AK_NTFY_LOADER_REFERRER__ || ''),
            loaderReferrerSearch: getLoaderReferrerSearch()
        });
        return;
    }

    var switchDone = false;
    var switchResult = null;
    var switchPromise = null;
    var appPatchTimer = null;
    var appPatchStartedAt = Date.now();
    var loginRedirectStarted = false;

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

    function pickIdentityKey(source) {
        if (!source || typeof source !== 'object') return '';
        var keys = ['Key', 'key', 'UserKey', 'userkey', 'user_key', 'ukey'];
        for (var i = 0; i < keys.length; i++) {
            if (source[keys[i]] != null && source[keys[i]] !== '') return String(source[keys[i]]).trim();
        }
        return '';
    }

    function hasIdentityPayload(source) {
        if (!source || typeof source !== 'object') return false;
        if (pickIdentityKey(source)) return true;
        var id = source.Id != null ? source.Id : (source.ID != null ? source.ID : source.id);
        return !!(id != null && String(id || '').trim() && String(id || '').trim() !== '0');
    }

    function decodeBase64Json(raw) {
        try {
            if (!raw) return null;
            var text = decodeURIComponent(escape(atob(String(raw || ''))));
            return JSON.parse(text);
        } catch (e) {}
        return null;
    }

    function readStoredCredentialUsername() {
        try {
            var parsed = decodeBase64Json(localStorage.getItem('_ak_sl'));
            return String(parsed && (parsed.a || parsed.account || parsed.Account) || '').trim().toLowerCase();
        } catch (e) {}
        return '';
    }

    function readLocalLoginInfoUsername() {
        try {
            var parsed = readJsonStorage(localStorage, 'AK_local_login_info');
            if (!Array.isArray(parsed)) return '';
            for (var i = 0; i < parsed.length; i++) {
                var username = String(parsed[i] && (parsed[i].account || parsed[i].Account || parsed[i].username || parsed[i].UserName) || '').trim().toLowerCase();
                if (username) return username;
            }
        } catch (e) {}
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

    function readMainLoginUsername() {
        try {
            var runtimeModel = window.APP && APP.USER && APP.USER.MODEL;
            var runtimeUser = hasIdentityPayload(runtimeModel) ? pickUsername(runtimeModel) : '';
            if (runtimeUser) return runtimeUser;
        } catch (e) {}
        try {
            var globalUser = hasIdentityPayload(window.USER_MODEL) ? pickUsername(window.USER_MODEL) : '';
            if (globalUser) return globalUser;
        } catch (e2) {}
        try {
            var keys = [getStoreKey(), 'AK_user_model', 'UserData', 'ak_login_result'];
            for (var i = 0; i < keys.length; i++) {
                var parsed = readJsonStorage(localStorage, keys[i]);
                if (keys[i] === 'ak_login_result' && parsed && parsed.UserData) parsed = parsed.UserData;
                if (!hasIdentityPayload(parsed)) continue;
                var username = pickUsername(parsed);
                if (username) return username;
            }
        } catch (e3) {}
        try {
            var sessionKeys = ['UserData', 'ak_login_result'];
            for (var j = 0; j < sessionKeys.length; j++) {
                var sessionParsed = readJsonStorage(sessionStorage, sessionKeys[j]);
                if (sessionKeys[j] === 'ak_login_result' && sessionParsed && sessionParsed.UserData) sessionParsed = sessionParsed.UserData;
                if (!hasIdentityPayload(sessionParsed)) continue;
                var sessionUsername = pickUsername(sessionParsed);
                if (sessionUsername) return sessionUsername;
            }
        } catch (e4) {}
        return '';
    }

    function readCurrentUsername() {
        var mainLoginUsername = readMainLoginUsername();
        if (mainLoginUsername) return mainLoginUsername;
        var credentialUsername = readStoredCredentialUsername();
        if (credentialUsername) return credentialUsername;
        var localLoginUsername = readLocalLoginInfoUsername();
        if (localLoginUsername) return localLoginUsername;
        return '';
    }

    function hasAkLoginState() {
        try {
            var directKeys = ['userkey', 'UserKey', '_ak_sl'];
            for (var d = 0; d < directKeys.length; d++) {
                if (String(localStorage.getItem(directKeys[d]) || sessionStorage.getItem(directKeys[d]) || '').trim()) return true;
            }
        } catch (e) {}
        try {
            var keys = [getStoreKey(), 'AK_user_model', 'UserData', 'ak_login_result'];
            for (var i = 0; i < keys.length; i++) {
                var localParsed = readJsonStorage(localStorage, keys[i]);
                if (keys[i] === 'ak_login_result' && localParsed && localParsed.UserData) localParsed = localParsed.UserData;
                if (hasIdentityPayload(localParsed)) return true;
                var sessionParsed = readJsonStorage(sessionStorage, keys[i]);
                if (keys[i] === 'ak_login_result' && sessionParsed && sessionParsed.UserData) sessionParsed = sessionParsed.UserData;
                if (hasIdentityPayload(sessionParsed)) return true;
            }
        } catch (e2) {}
        return false;
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
        try { window.AKIMClientUsername = ''; } catch (e5) {}
        try { window.userkey = ''; } catch (e8) {}
        try { window.USER_MODEL = { Id: 0, Key: '' }; } catch (e6) {}
        try {
            if (window.APP && APP.USER) APP.USER.MODEL = { Id: 0, Key: '' };
        } catch (e7) {}
    }

    function isLoginPage() {
        try {
            return String(window.location.pathname || '').toLowerCase() === '/pages/account/login.html';
        } catch (e) {}
        return false;
    }

    function buildLoginUrl(reason) {
        return '/pages/account/login.html?reason='
            + encodeURIComponent(String(reason || 'ntfy_token_invalid'))
            + '&im_username=' + encodeURIComponent(targetUsername);
    }

    function fallbackRedirectToLogin(loginUrl, source) {
        debug('token-failure-fallback-login', {
            source: String(source || ''),
            loginUrl: String(loginUrl || '')
        });
        try {
            window.location.replace(loginUrl);
        } catch (e) {
            window.location.href = loginUrl;
        }
    }

    function tryNativeGotoLogin(reason, loginUrl) {
        try {
            if (window.APP && APP.GLOBAL && typeof APP.GLOBAL.gotoLogin === 'function') {
                debug('token-failure-native-goto-login', { reason: String(reason || '') });
                APP.GLOBAL.gotoLogin();
                setTimeout(function() {
                    if (!isLoginPage()) fallbackRedirectToLogin(loginUrl, 'native_goto_timeout');
                }, LOGIN_GOTO_FALLBACK_MS);
                return true;
            }
        } catch (e) {
            debug('token-failure-native-goto-error', {
                reason: String(reason || ''),
                message: String(e && e.message || e || '')
            });
        }
        return false;
    }

    function scheduleNativeGotoLogin(reason, loginUrl) {
        if (isLoginPage()) {
            debug('token-failure-already-login-page', { reason: String(reason || '') });
            return;
        }
        if (tryNativeGotoLogin(reason, loginUrl)) return;
        var startedAt = Date.now();
        var timer = setInterval(function() {
            if (tryNativeGotoLogin(reason, loginUrl)) {
                clearInterval(timer);
                return;
            }
            if (Date.now() - startedAt >= LOGIN_GOTO_WAIT_MS) {
                clearInterval(timer);
                fallbackRedirectToLogin(loginUrl, 'native_goto_unavailable');
            }
        }, LOGIN_GOTO_POLL_MS);
    }

    function redirectToLoginForTokenFailure(reason) {
        if (loginRedirectStarted) return;
        loginRedirectStarted = true;
        var loginUrl = buildLoginUrl(reason);
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
        scheduleNativeGotoLogin(reason || 'ntfy_token_invalid', loginUrl);
    }

    function maybeRedirectToLoginOnSwitchFailure(result) {
        result = result || {};
        if (result.synced) return false;
        var reason = String(result.reason || '').trim();
        var mainLoginUsername = readMainLoginUsername();
        var currentUsername = mainLoginUsername || readCurrentUsername();
        var hasLoginState = hasAkLoginState();
        var terminalTokenFailure = isTokenTerminalFailure(reason, result.status);
        if (!terminalTokenFailure) return false;
        debug('switch-failure-check-current', {
            reason: reason,
            status: Number(result.status || 0),
            currentUsername: currentUsername,
            mainLoginUsername: mainLoginUsername,
            hasLoginState: hasLoginState,
            terminalTokenFailure: terminalTokenFailure
        });
        if (mainLoginUsername && mainLoginUsername === targetUsername && hasLoginState) return false;
        clearAkLoginStateForRelogin();
        redirectToLoginForTokenFailure(terminalTokenFailure ? (reason || 'ntfy_token_invalid') : 'ntfy_switch_failed');
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
        if (maybeRedirectToLoginOnSwitchFailure(switchResult)) {
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
                        if (result && result.redirecting) {
                            debug('indexdata-gate-block-redirecting', {});
                            return;
                        }
                        refreshAppModel();
                        debug('indexdata-gate-send', { reason: result && result.reason ? result.reason : '' });
                        nativeSend.call(xhr, patchIndexDataBody(body));
                    }).catch(function() {
                        var lock = getLock();
                        if (lock && lock.redirecting) {
                            debug('indexdata-gate-fallback-block-redirecting', {});
                            return;
                        }
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

    if (isForceLoginCleanup) {
        clearAkLoginStateForRelogin();
        updateLock({
            active: false,
            pending: false,
            synced: false,
            failed: true,
            cleanupOnly: true,
            reason: reasonFlag || 'ntfy_force_login'
        });
        debug('force-login-cleanup-only', {
            reason: reasonFlag || '',
            currentUsername: readCurrentUsername(),
            hasLoginState: hasAkLoginState()
        });
        if (!isLoginPage()) {
            redirectToLoginForTokenFailure(reasonFlag || 'ntfy_force_login');
        }
        return;
    }

    updateLock({ active: true, pending: true, synced: false, failed: false, startedAt: Date.now() });
    installHomeSyncHook();
    installIndexDataGate();
    installAppPatchWatchdog();
    startSwitch();
})();
