(function() {
    'use strict';

    var AK_CRED_KEY = '_ak_sl';

    function encodeCredentials(account, password) {
        try { return btoa(unescape(encodeURIComponent(JSON.stringify({a:account,p:password,t:Date.now()})))); }
        catch(e) { return null; }
    }

    function decodeCredentials() {
        try {
            var raw = localStorage.getItem(AK_CRED_KEY);
            if (!raw) return null;
            var data = JSON.parse(decodeURIComponent(escape(atob(raw))));
            if (Date.now() - data.t > 30*86400000) { localStorage.removeItem(AK_CRED_KEY); return null; }
            return {account:data.a, password:data.p};
        } catch(e) { localStorage.removeItem(AK_CRED_KEY); return null; }
    }

    function saveCredentials(account, password) {
        if (account && password) {
            var encoded = encodeCredentials(account, password);
            if (encoded) localStorage.setItem(AK_CRED_KEY, encoded);
        }
    }

    function clearCredentials() { localStorage.removeItem(AK_CRED_KEY); }

    function extractUserKey(data) {
        try {
            if (!data || typeof data !== 'object') return '';
            if (Array.isArray(data)) {
                for (var i = 0; i < data.length; i++) {
                    var arrKey = extractUserKey(data[i]);
                    if (arrKey) return arrKey;
                }
                return '';
            }
            for (var k in data) {
                if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                var lk = String(k || '').toLowerCase();
                if ((lk === 'key' || lk === 'userkey' || lk === 'user_key' || lk === 'ukey') && data[k] != null && data[k] !== '') {
                    return String(data[k]);
                }
            }
            for (var k2 in data) {
                if (!Object.prototype.hasOwnProperty.call(data, k2)) continue;
                var subKey = extractUserKey(data[k2]);
                if (subKey) return subKey;
            }
        } catch(e) {}
        return '';
    }

    function syncLoginUsernameCookie(account) {
        try {
            var username = String(account || '').trim().toLowerCase();
            if (!username) return false;
            var maxAge = String(86400 * 30);
            document.cookie = 'ak_username=' + encodeURIComponent(username) + '; path=/; max-age=' + maxAge + '; SameSite=Lax';
            document.cookie = 'ak_im_username=' + encodeURIComponent(username) + '; path=/; max-age=' + maxAge + '; SameSite=Lax';
            return true;
        } catch(e) {}
        return false;
    }

    function readCookie(name) {
        try {
            var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
            return match ? decodeURIComponent(match[1] || '').trim() : '';
        } catch(e) {}
        return '';
    }

    function pickUsernameFromObject(data) {
        try {
            if (!data || typeof data !== 'object') return '';
            var keys = ['UserName', 'Username', 'userName', 'username', 'Account', 'account', 'LoginName', 'loginName'];
            for (var i = 0; i < keys.length; i++) {
                if (data[keys[i]] != null && data[keys[i]] !== '') return String(data[keys[i]]).trim();
            }
        } catch(e) {}
        return '';
    }

    function readActiveUsernameFromAppModel() {
        try {
            return pickUsernameFromObject(window.APP && APP.USER && APP.USER.MODEL);
        } catch(e) {}
        return '';
    }

    function ensureIMUsernameCookieFromUserModel() {
        try {
            var username = readActiveUsernameFromAppModel();
            if (!username) return false;
            var normalized = String(username || '').trim().toLowerCase();
            if (!normalized) return false;
            var akUsername = readCookie('ak_username').toLowerCase();
            var imUsername = readCookie('ak_im_username').toLowerCase();
            if (akUsername === normalized && imUsername === normalized) return false;
            return syncLoginUsernameCookie(normalized);
        } catch(e) {}
        return false;
    }

    function storeUserModel(result) {
        try {
            if (!result || typeof result !== 'object') return;
            var userData = result.UserData && typeof result.UserData === 'object' ? result.UserData : null;
            if (!userData) return;
            var model = Object.assign({}, userData);
            var key = extractUserKey(result);
            if (key) model.Key = key;
            var storeKey = 'AK_user_model';
            try {
                if (window.APP && APP.CONFIG && APP.CONFIG.SYSTEM_KEYS && APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY) {
                    storeKey = APP.CONFIG.SYSTEM_KEYS.USER_MODEL_KEY;
                }
            } catch(e) {}
            localStorage.setItem(storeKey, JSON.stringify(model));
            syncLoginUsernameCookie(pickUsernameFromObject(model));
            if (window.APP && APP.USER) {
                APP.USER.MODEL = model;
            }
            window.USER_MODEL = model;
        } catch(e) {}
    }

    function hasPersistCookie() {
        return false;
    }

    function installRuntimeContext() {
        try {
            window.AKClientRuntimeContext = window.AKClientRuntimeContext || {};
            window.AKClientRuntimeContext.hasPersistCookie = hasPersistCookie;
        } catch(e) {
        }
    }

    function extractCredentials(body) {
        var account = '', password = '';
        if (!body) return null;
        if (typeof body === 'string') {
            try {
                var json = JSON.parse(body);
                account = json.account || json.Account || '';
                password = json.password || json.Password || '';
            } catch(e) {
                try {
                    var params = new URLSearchParams(body);
                    account = params.get('account') || params.get('Account') || '';
                    password = params.get('password') || params.get('Password') || '';
                } catch(e2) {}
            }
        }
        if (account && password) return {account: account, password: password};
        return null;
    }

    function reconnectChatAfterCredentialSave() {
        try {
            if (window.AKChat && window.AKChat.reconnect) window.AKChat.reconnect();
        } catch(e) {}
    }

    function setupLoginCapture() {
        if (window.__AKChatLoginCaptureInstalled) return;
        window.__AKChatLoginCaptureInstalled = true;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
            var xhr = this;
            xhr._akReqBody = body;
            xhr.addEventListener('load', function() {
                try {
                    var url = xhr.responseURL || '';
                    if (url.indexOf('/Login') === -1) return;
                    var result = JSON.parse(xhr.responseText);
                    if (result.Error !== false && (result.Error || !result.UserData)) return;
                    var creds = extractCredentials(xhr._akReqBody);
                    if (creds) syncLoginUsernameCookie(creds.account);
                    storeUserModel(result);
                    if (!hasPersistCookie()) return;
                    if (creds) {
                        saveCredentials(creds.account, creds.password);
                        reconnectChatAfterCredentialSave();
                    }
                } catch(e) {}
            });
            return origSend.call(this, body);
        };

        var prevFetch = window.fetch;
        window.fetch = function(url, options) {
            var isLogin = typeof url === 'string' && url.indexOf('/Login') !== -1;
            var result = prevFetch.call(this, url, options);
            if (isLogin && options && options.body) {
                result.then(function(resp) {
                    resp.clone().json().then(function(data) {
                        if (data.Error === false || (!data.Error && data.UserData)) {
                            var creds = extractCredentials(options.body);
                            if (creds) syncLoginUsernameCookie(creds.account);
                            storeUserModel(data);
                            if (!hasPersistCookie()) return;
                            if (creds) {
                                saveCredentials(creds.account, creds.password);
                                reconnectChatAfterCredentialSave();
                            }
                        }
                    }).catch(function(){});
                }).catch(function(){});
            }
            return result;
        };
    }

    function autoLogin() {
        var path = window.location.pathname.toLowerCase();
        if (path.indexOf('/login') === -1) return;

        var creds = decodeCredentials();
        if (!creds) { return; }
        if (!hasPersistCookie()) { clearCredentials(); return; }

        var hideStyle = document.createElement('style');
        hideStyle.id = 'ak-autologin-hide';
        hideStyle.textContent = 'body{visibility:hidden!important}';
        (document.head || document.documentElement).appendChild(hideStyle);
        setTimeout(clearAutoLoginHide, 800);

        var attempts = 0;
        function clearAutoLoginHide() {
            var style = document.getElementById('ak-autologin-hide');
            if (style) style.remove();
        }

        function tryFormLogin() {
            attempts++;
            if (attempts > 15) {
                clearAutoLoginHide();
                return;
            }

            var inputs = document.querySelectorAll('input');
            var accountInput = null, passwordInput = null;
            for (var i = 0; i < inputs.length; i++) {
                var type = (inputs[i].type || '').toLowerCase();
                if (type === 'password') passwordInput = inputs[i];
                else if (type === 'text' || type === 'tel' || type === 'email') {
                    if (!accountInput) accountInput = inputs[i];
                }
            }

            if (!accountInput || !passwordInput) {
                setTimeout(tryFormLogin, 500);
                return;
            }

            try {
                var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(accountInput, creds.account);
                setter.call(passwordInput, creds.password);
            } catch(e) {
                accountInput.value = creds.account;
                passwordInput.value = creds.password;
            }
            ['input','change','keyup'].forEach(function(evt) {
                accountInput.dispatchEvent(new Event(evt, {bubbles:true}));
                passwordInput.dispatchEvent(new Event(evt, {bubbles:true}));
            });

            setTimeout(function() {
                var btns = document.querySelectorAll('button, input[type="submit"], a.btn, .btn, [onclick]');
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent || btns[i].value || '').trim();
                    if (text.indexOf('登录') !== -1 || text.indexOf('登入') !== -1 || text.toLowerCase().indexOf('login') !== -1) {
                        clearAutoLoginHide();
                        btns[i].click();
                        return;
                    }
                }
                clearAutoLoginHide();
            }, 500);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() { setTimeout(tryFormLogin, 300); });
        } else {
            setTimeout(tryFormLogin, 300);
        }
    }

    window.AKClientRuntimeAuth = window.AKClientRuntimeAuth || {};
    window.AKClientRuntimeAuth.decodeCredentials = decodeCredentials;
    window.AKClientRuntimeAuth.clearCredentials = clearCredentials;
    window.AKClientRuntimeAuth.hasPersistCookie = hasPersistCookie;
    window.AKClientRuntimeAuth.installRuntimeContext = installRuntimeContext;
    window.AKClientRuntimeAuth.syncLoginUsernameCookie = syncLoginUsernameCookie;
    window.AKClientRuntimeAuth.ensureIMUsernameCookieFromUserModel = ensureIMUsernameCookieFromUserModel;
    window.AKClientRuntimeAuth.setupLoginCapture = setupLoginCapture;
    window.AKClientRuntimeAuth.autoLogin = autoLogin;
})();
