(function() {
    'use strict';

    const CHAT_PAGE_CLIENT_ID_STORAGE_KEY = 'ak_chat_page_client_id';
    let pageClientId = '';

    function buildGuestUsername() {
        return 'guest_' + Math.random().toString(36).substr(2, 6);
    }

    function pickUsernameFromObject(source) {
        if (!source || typeof source !== 'object') return '';
        const fields = ['UserName', 'username', 'Account', 'account'];
        for (let i = 0; i < fields.length; i++) {
            const value = source[fields[i]];
            if (typeof value === 'string' && value.trim()) {
                return String(value).trim();
            }
        }
        return '';
    }

    function getStoredUserModelUsername() {
        const keys = ['AK_user_model'];
        try {
            if (window.APP && APP.CONFIG && APP.CONFIG.SYSTEM_KEYS && APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY) {
                const storeKey = String(APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY || '').trim();
                if (storeKey && keys.indexOf(storeKey) === -1) {
                    keys.unshift(storeKey);
                }
            }
        } catch (e) {}
        try {
            for (let i = 0; i < keys.length; i++) {
                const raw = localStorage.getItem(keys[i]);
                if (!raw) continue;
                const parsed = JSON.parse(raw);
                const resolved = pickUsernameFromObject(parsed);
                if (resolved) return resolved;
            }
        } catch (e) {}
        return '';
    }

    function getStoredCanonicalUsername() {
        const storageKeys = ['UserData', 'ak_login_result'];
        const stores = [localStorage, sessionStorage];
        try {
            for (let si = 0; si < stores.length; si++) {
                const store = stores[si];
                if (!store) continue;
                for (let i = 0; i < storageKeys.length; i++) {
                    const raw = store.getItem(storageKeys[i]);
                    if (!raw) continue;
                    const parsed = JSON.parse(raw);
                    const target = storageKeys[i] === 'ak_login_result'
                        ? (parsed && parsed.UserData && typeof parsed.UserData === 'object' ? parsed.UserData : null)
                        : parsed;
                    const resolved = pickUsernameFromObject(target);
                    if (resolved) return resolved;
                }
            }
        } catch (e) {}
        return '';
    }

    function getCookie(name) {
        let match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : null;
    }

    function getNtfyIdentityLockUsername() {
        try {
            const lock = window.__AK_NTFY_IDENTITY_LOCK__;
            if (!lock || typeof lock !== 'object' || lock.failed) return '';
            const username = String(lock.username || lock.targetUsername || '').trim();
            return username || '';
        } catch (e) {}
        return '';
    }

    function getUsername(options) {
        options = options || {};
        let lockedUser = getNtfyIdentityLockUsername();
        if (lockedUser) return lockedUser;

        let cookieUser = getCookie('ak_username');
        if (cookieUser) return String(cookieUser).trim();

        try {
            if (window.APP && APP.USER && APP.USER.MODEL) {
                let runtimeUser = pickUsernameFromObject(APP.USER.MODEL);
                if (runtimeUser) return runtimeUser;
            }
        } catch(e) {}
        try {
            let globalUser = pickUsernameFromObject(window.USER_MODEL);
            if (globalUser) return globalUser;
        } catch(e) {}

        let storedUserModel = getStoredUserModelUsername();
        if (storedUserModel) return storedUserModel;

        let canonicalUser = getStoredCanonicalUsername();
        if (canonicalUser) return canonicalUser;

        try {
            for (let i = 0; i < localStorage.length; i++) {
                let value = localStorage.getItem(localStorage.key(i));
                try {
                    let data = JSON.parse(value);
                    let resolved = pickUsernameFromObject(data);
                    if (resolved) return resolved;
                } catch(e) {}
            }
        } catch(e) {}

        try {
            var decodeCredentials = options.decodeCredentials;
            var saved = typeof decodeCredentials === 'function' ? decodeCredentials() : null;
            if (saved && saved.account) return String(saved.account).trim();
        } catch(e) {}

        let currentUsername = String(options.currentUsername || '').trim();
        if (currentUsername) {
            if (currentUsername === 'visitor') return buildGuestUsername();
            return currentUsername;
        }
        return buildGuestUsername();
    }

    function generatePageClientId() {
        return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function getPageClientId() {
        if (pageClientId) return pageClientId;
        try {
            const stored = String(sessionStorage.getItem(CHAT_PAGE_CLIENT_ID_STORAGE_KEY) || '').trim();
            if (stored) {
                pageClientId = stored;
                return pageClientId;
            }
            pageClientId = generatePageClientId();
            sessionStorage.setItem(CHAT_PAGE_CLIENT_ID_STORAGE_KEY, pageClientId);
            return pageClientId;
        } catch (e) {
            pageClientId = pageClientId || generatePageClientId();
            return pageClientId;
        }
    }

    window.AKClientRuntimePresenceIdentity = window.AKClientRuntimePresenceIdentity || {};
    window.AKClientRuntimePresenceIdentity.getUsername = getUsername;
    window.AKClientRuntimePresenceIdentity.getPageClientId = getPageClientId;
})();
