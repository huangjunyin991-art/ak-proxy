(function() {
    'use strict';

    var PASSWORD_ERROR_COUNTDOWN_SECONDS = 5;
    var LOGIN_SUBMIT_BLOCK_MS = PASSWORD_ERROR_COUNTDOWN_SECONDS * 1000;
    var lastLoginSubmitAt = 0;
    var lastPasswordErrorPassword = '';
    var pendingAccountHintLoginAccount = '';

    function isLoginPage() {
        try {
            return String(window.location.pathname || '').toLowerCase() === '/pages/account/login.html';
        } catch(e) {
            return false;
        }
    }

    function isPasswordErrorMessage(message) {
        var text = String(message || '');
        var hasPassword = text.indexOf('密码') >= 0 || text.indexOf('密碼') >= 0 || text.toLowerCase().indexOf('password') >= 0;
        var hasFailure = text.indexOf('不正确') >= 0 || text.indexOf('不正確') >= 0 || text.indexOf('错误') >= 0 || text.indexOf('錯誤') >= 0 || text.toLowerCase().indexOf('incorrect') >= 0;
        return hasPassword && hasFailure;
    }

    function getLoginPasswordInputValue() {
        try {
            var input = getLoginPasswordInput();
            return input ? String(input.value || '') : '';
        } catch(e) {}
        return '';
    }

    function getLoginPasswordInput() {
        try {
            return document.querySelector('input[type="password"], input[name="password"]');
        } catch(e) {}
        return null;
    }

    function getCurrentLoginPassword() {
        var inputValue = getLoginPasswordInputValue();
        if (inputValue) return inputValue;
        try {
            if (window._vue && window._vue.form) {
                return String(window._vue.form.password || '');
            }
        } catch(e) {}
        return '';
    }

    function setNativeInputValue(input, value) {
        if (!input) return;
        try {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (setter) setter.call(input, String(value || ''));
            else input.value = String(value || '');
        } catch(e) {
            try { input.value = String(value || ''); } catch(e2) {}
        }
    }

    function dispatchInputEvents(input) {
        if (!input) return;
        try {
            ['input', 'change', 'keyup', 'blur'].forEach(function(evt) {
                input.dispatchEvent(new Event(evt, { bubbles: true }));
            });
        } catch(e) {}
    }

    function inputTextMeta(input) {
        try {
            return [
                input.name,
                input.id,
                input.getAttribute('autocomplete'),
                input.getAttribute('placeholder'),
                input.getAttribute('aria-label')
            ].join(' ').toLowerCase();
        } catch(e) {}
        return '';
    }

    function isAccountLikeInput(input) {
        if (!input) return false;
        try {
            if (input.disabled || input.readOnly) return false;
            var type = String(input.type || 'text').toLowerCase();
            if (['password', 'hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file'].indexOf(type) >= 0) return false;
            var meta = inputTextMeta(input);
            if (/captcha|verify|verification|code|otp|google|password|密码|密碼|验证码|驗證碼|谷歌|动态|動態/.test(meta)) return false;
            return ['text', 'tel', 'email', 'search', ''].indexOf(type) >= 0 || /account|username|user|login|账号|帳號/.test(meta);
        } catch(e) {}
        return false;
    }

    function getLoginAccountInputs() {
        try {
            var passwordInput = getLoginPasswordInput();
            var inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
            var scored = [];
            inputs.forEach(function(input, index) {
                if (!isAccountLikeInput(input)) return;
                var meta = inputTextMeta(input);
                var score = 0;
                if (/account|username|login|账号|帳號/.test(meta)) score += 100;
                if (/user/.test(meta)) score += 40;
                if (passwordInput && input.form && passwordInput.form && input.form === passwordInput.form) score += 30;
                if (passwordInput && input.compareDocumentPosition) {
                    try {
                        if (input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING) score += 20;
                    } catch(e) {}
                }
                if (input.offsetParent !== null) score += 10;
                scored.push({ input: input, score: score, index: index });
            });
            scored.sort(function(a, b) {
                if (b.score !== a.score) return b.score - a.score;
                return a.index - b.index;
            });
            var threshold = scored.length && scored[0].score >= 100 ? 80 : 0;
            return scored.filter(function(item) {
                return item.score >= threshold;
            }).slice(0, 2).map(function(item) { return item.input; });
        } catch(e) {}
        return [];
    }

    function getLoginAccountInputValue() {
        try {
            var inputs = getLoginAccountInputs();
            var input = inputs.length ? inputs[0] : null;
            return input ? String(input.value || '') : '';
        } catch(e) {}
        return '';
    }

    function getCurrentLoginAccount() {
        var inputValue = getLoginAccountInputValue().trim();
        if (inputValue) return inputValue;
        try {
            if (window._vue && window._vue.form) {
                return String(window._vue.form.account || '').trim();
            }
        } catch(e) {}
        return '';
    }

    function setCurrentLoginAccount(account) {
        var value = String(account || '').trim();
        if (!value) return;
        try {
            if (window._vue && window._vue.form) {
                window._vue.form.account = value;
                if (typeof window._vue.checkInput === 'function') window._vue.checkInput();
            }
        } catch(e) {}
        try {
            getLoginAccountInputs().forEach(function(input) {
                setNativeInputValue(input, value);
                try { input.setAttribute('autocomplete', 'username'); } catch(e) {}
                dispatchInputEvents(input);
            });
        } catch(e) {}
    }

    function syncLoginInputsToVue() {
        var account = pendingAccountHintLoginAccount || getLoginAccountInputValue().trim();
        var password = getLoginPasswordInputValue();
        if (account) setCurrentLoginAccount(account);
        if (password) setCurrentLoginPassword(password);
    }

    function restoreLoginPasswordForRetry() {
        var password = getCurrentLoginPassword() || lastPasswordErrorPassword;
        if (password) setCurrentLoginPassword(password);
    }

    function setCurrentLoginPassword(password) {
        var value = String(password || '');
        try {
            if (window._vue && window._vue.form) {
                window._vue.form.password = value;
                if (typeof window._vue.checkInput === 'function') window._vue.checkInput();
            }
        } catch(e) {}
        try {
            var input = getLoginPasswordInput();
            if (input) {
                setNativeInputValue(input, value);
                try { input.setAttribute('autocomplete', 'current-password'); } catch(e) {}
                dispatchInputEvents(input);
            }
        } catch(e) {}
    }

    function rememberAccountHintLoginAccount(account) {
        pendingAccountHintLoginAccount = String(account || '').trim();
    }

    function rewriteLoginBodyAccount(body, account) {
        account = String(account || '').trim();
        if (!account || body == null) return body;
        try {
            if (typeof body === 'string') {
                var text = body;
                var trimmed = text.trim();
                if (trimmed.charAt(0) === '{') {
                    var json = JSON.parse(text);
                    if (json && typeof json === 'object') {
                        if (Object.prototype.hasOwnProperty.call(json, 'Account')) json.Account = account;
                        else json.account = account;
                        return JSON.stringify(json);
                    }
                    return body;
                }
                var params = new URLSearchParams(text);
                if (params.has('Account')) params.set('Account', account);
                params.set('account', account);
                return params.toString();
            }
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                if (body.has('Account')) body.set('Account', account);
                body.set('account', account);
                return body;
            }
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                if (body.has('Account')) body.set('Account', account);
                body.set('account', account);
                return body;
            }
        } catch(e) {}
        return body;
    }

    function isLoginRequestUrl(url) {
        try {
            var path = new URL(String(url || ''), window.location.href).pathname.toLowerCase();
            return (path === '/login' || path.slice(-6) === '/login') && path.indexOf('/api/login/') < 0 && path.slice(-5) !== '.html';
        } catch(e) {
            var text = String(url || '').toLowerCase();
            return text.indexOf('account_hint') < 0 && text.indexOf('.html') < 0 && /(^|\/)login([?#]|$)/.test(text);
        }
    }

    function installAccountHintLoginRequestPatch() {
        if (window.__AKAccountHintLoginRequestPatchInstalled) return;
        window.__AKAccountHintLoginRequestPatchInstalled = true;
        try {
            var originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                this.__akAccountHintLoginUrl = url;
                return originalOpen.apply(this, arguments);
            };
            var originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(body) {
                if (pendingAccountHintLoginAccount && isLoginRequestUrl(this.__akAccountHintLoginUrl)) {
                    setCurrentLoginAccount(pendingAccountHintLoginAccount);
                    restoreLoginPasswordForRetry();
                    body = rewriteLoginBodyAccount(body, pendingAccountHintLoginAccount);
                    pendingAccountHintLoginAccount = '';
                }
                return originalSend.call(this, body);
            };
        } catch(e) {}
        try {
            if (typeof window.fetch === 'function') {
                var originalFetch = window.fetch;
                window.fetch = function(input, init) {
                    var url = '';
                    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch(e) {}
                    if (pendingAccountHintLoginAccount && isLoginRequestUrl(url)) {
                        init = init || {};
                        setCurrentLoginAccount(pendingAccountHintLoginAccount);
                        restoreLoginPasswordForRetry();
                        if (Object.prototype.hasOwnProperty.call(init, 'body')) {
                            init = Object.assign({}, init, {
                                body: rewriteLoginBodyAccount(init.body, pendingAccountHintLoginAccount)
                            });
                        }
                        pendingAccountHintLoginAccount = '';
                    }
                    return originalFetch.call(this, input, init);
                };
            }
        } catch(e2) {}
    }

    function scheduleAccountFieldResync(account) {
        account = String(account || '').trim();
        if (!account) return;
        var attempts = 0;
        var timer = setInterval(function() {
            attempts += 1;
            setCurrentLoginAccount(account);
            restoreLoginPasswordForRetry();
            if (attempts >= 20) clearInterval(timer);
        }, 100);
    }

    function resetLoginLoadingState() {
        try {
            var vm = window._vue;
            if (!vm || typeof vm !== 'object') return;
            [
                'isLogin',
                'loading',
                'loginLoading',
                'submitLoading',
                'btnLoading',
                'disabled',
                'submitDisabled'
            ].forEach(function(key) {
                if (Object.prototype.hasOwnProperty.call(vm, key)) vm[key] = false;
            });
        } catch(e) {}
    }

    function escapeHtml(value) {
        var div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function buildDiffHtml(source, target) {
        var left = String(source || '');
        var right = String(target || '');
        var prefixLen = 0;
        while (
            prefixLen < left.length &&
            prefixLen < right.length &&
            left.charAt(prefixLen) === right.charAt(prefixLen)
        ) {
            prefixLen += 1;
        }
        var suffixLen = 0;
        while (
            suffixLen < left.length - prefixLen &&
            suffixLen < right.length - prefixLen &&
            left.charAt(left.length - 1 - suffixLen) === right.charAt(right.length - 1 - suffixLen)
        ) {
            suffixLen += 1;
        }
        var prefix = left.slice(0, prefixLen);
        var middleEnd = suffixLen ? left.length - suffixLen : left.length;
        var middle = left.slice(prefixLen, middleEnd);
        var suffix = suffixLen ? left.slice(left.length - suffixLen) : '';
        var html = escapeHtml(prefix);
        if (middle) {
            html += '<span style="color:#d93025;font-weight:800;">' + escapeHtml(middle) + '</span>';
        }
        html += escapeHtml(suffix);
        return html || '-';
    }

    function renderAccountHint(typedAccount, suggestedAccount) {
        if (!typedAccount || !suggestedAccount || typedAccount === suggestedAccount) return '';
        return '' +
            '<div style="margin:2px 20px 12px;padding:10px 12px;background:#fff7f7;border:1px solid rgba(217,48,37,.18);border-radius:4px;text-align:left;">' +
                '<div style="font-size:12px;line-height:1.6;color:#333;">您是否想输入的账号是 <span style="color:#d93025;font-weight:800;">' + escapeHtml(suggestedAccount) + '</span>？</div>' +
                '<div style="margin-top:6px;font-size:11px;line-height:1.7;color:#777;word-break:break-all;">输入账号：' + buildDiffHtml(typedAccount, suggestedAccount) + '</div>' +
                '<div style="font-size:11px;line-height:1.7;color:#777;word-break:break-all;">匹配账号：' + buildDiffHtml(suggestedAccount, typedAccount) + '</div>' +
                '<button type="button" id="ak-login-use-account-hint" data-account="' + escapeHtml(suggestedAccount) + '" disabled style="margin-top:8px;width:100%;height:30px;border:0;border-radius:4px;background:#f1b3ad;color:#fff;font-size:12px;font-weight:700;cursor:not-allowed;">使用该账号(' + PASSWORD_ERROR_COUNTDOWN_SECONDS + 's)</button>' +
            '</div>';
    }

    function closeDialog(overlay) {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function fetchAccountHint(account) {
        account = String(account || '').trim();
        if (account.length < 4 || account.length > 64 || typeof fetch !== 'function') {
            return Promise.resolve(null);
        }
        return fetch('/api/login/account_hint?account=' + encodeURIComponent(account), {
            credentials: 'same-origin',
            cache: 'no-store'
        }).then(function(response) {
            if (!response || !response.ok) return null;
            return response.json();
        }).catch(function() {
            return null;
        });
    }

    function updateUseAccountHintCountdown(remaining) {
        var button = document.getElementById('ak-login-use-account-hint');
        if (!button) return;
        if (remaining > 0) {
            button.disabled = true;
            button.textContent = '使用该账号(' + remaining + 's)';
            button.style.background = '#f1b3ad';
            button.style.cursor = 'not-allowed';
            return;
        }
        button.disabled = false;
        button.textContent = '使用该账号';
        button.style.background = '#d93025';
        button.style.cursor = 'pointer';
    }

    function installUseAccountHintHandler() {
        var button = document.getElementById('ak-login-use-account-hint');
        if (!button || button.__akAccountHintBound) return;
        button.__akAccountHintBound = true;
        button.onclick = function() {
            if (button.disabled) return;
            var account = button.getAttribute('data-account') || '';
            rememberAccountHintLoginAccount(account);
            setCurrentLoginAccount(account);
            restoreLoginPasswordForRetry();
            scheduleAccountFieldResync(account);
            resetLoginLoadingState();
            closeDialog(document.getElementById('ak-login-password-error-overlay'));
        };
    }

    function installLoginSubmitSilentThrottlePatch() {
        if (!isLoginPage() || window.__AKLoginSubmitSilentThrottlePatchInstalled) return;
        window.__AKLoginSubmitSilentThrottlePatchInstalled = true;
        var attempts = 0;
        var timer = setInterval(function() {
            attempts += 1;
            var vm = window._vue;
            if (!vm || typeof vm.doLoginAjax !== 'function') {
                if (attempts >= 100) clearInterval(timer);
                return;
            }
            clearInterval(timer);
            if (vm.__akLoginSubmitSilentThrottlePatched) return;
            vm.__akLoginSubmitSilentThrottlePatched = true;
            var originalDoLoginAjax = vm.doLoginAjax;
            vm.doLoginAjax = function() {
                var now = Date.now();
                if (lastLoginSubmitAt && now - lastLoginSubmitAt < LOGIN_SUBMIT_BLOCK_MS) {
                    resetLoginLoadingState();
                    return;
                }
                syncLoginInputsToVue();
                lastLoginSubmitAt = now;
                return originalDoLoginAjax.apply(this, arguments);
            };
        }, 100);
    }

    function showPasswordErrorDialog(message) {
        var oldOverlay = document.getElementById('ak-login-password-error-overlay');
        if (oldOverlay) closeDialog(oldOverlay);
        var password = getCurrentLoginPassword();
        var typedAccount = getCurrentLoginAccount();
        lastPasswordErrorPassword = password;
        var overlay = document.createElement('div');
        overlay.id = 'ak-login-password-error-overlay';
        overlay.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
        overlay.innerHTML = '' +
            '<div style="width:82%;max-width:320px;background:#fff;border-radius:2px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-family:Arial,Helvetica,sans-serif;color:#333;text-align:center;overflow:hidden;">' +
                '<div style="padding:20px 18px 8px;font-size:13px;font-weight:700;color:#111;">AK</div>' +
                '<div style="padding:6px 20px 8px;font-size:12px;color:#8a8a8a;line-height:1.8;">' + escapeHtml(message) + '</div>' +
                '<div style="padding:0 20px 12px;font-size:12px;color:#8a8a8a;line-height:1.8;word-break:break-all;">當前輸入的密碼為：<span style="color:#d93025;font-weight:700;">' + escapeHtml(password) + '</span>，請確認後重試！</div>' +
                '<button type="button" id="ak-login-password-error-ok" disabled style="width:100%;height:48px;border:0;background:#fff;color:#9aa0a6;font-size:13px;cursor:not-allowed;border-top:1px solid rgba(0,0,0,.06);">確認(' + PASSWORD_ERROR_COUNTDOWN_SECONDS + 's)</button>' +
            '</div>';
        document.body.appendChild(overlay);
        var hintSlot = document.createElement('div');
        hintSlot.id = 'ak-login-account-hint-slot';
        var hintAnchorButton = document.getElementById('ak-login-password-error-ok');
        var remaining = PASSWORD_ERROR_COUNTDOWN_SECONDS;
        if (hintAnchorButton && hintAnchorButton.parentNode) {
            hintAnchorButton.parentNode.insertBefore(hintSlot, hintAnchorButton);
        }
        fetchAccountHint(typedAccount).then(function(hint) {
            try {
                var slot = document.getElementById('ak-login-account-hint-slot');
                if (!slot || !hint || !hint.suggested_account) return;
                slot.innerHTML = renderAccountHint(typedAccount, String(hint.suggested_account || ''));
                updateUseAccountHintCountdown(remaining);
                installUseAccountHintHandler();
            } catch(e) {}
        });
        var button = document.getElementById('ak-login-password-error-ok');
        var timer = setInterval(function() {
            remaining -= 1;
            if (!button || !button.parentNode) {
                clearInterval(timer);
                return;
            }
            updateUseAccountHintCountdown(remaining);
            if (remaining > 0) {
                button.textContent = '確認(' + remaining + 's)';
                return;
            }
            clearInterval(timer);
            button.disabled = false;
            button.textContent = '確認';
            button.style.color = '#1677ff';
            button.style.cursor = 'pointer';
            button.onclick = function() {
                restoreLoginPasswordForRetry();
                closeDialog(overlay);
            };
        }, 1000);
    }

    function installLoginPasswordErrorPatch() {
        if (!isLoginPage() || window.__AKLoginPasswordErrorPatchInstalled) return;
        window.__AKLoginPasswordErrorPatchInstalled = true;
        installAccountHintLoginRequestPatch();
        installLoginSubmitSilentThrottlePatch();
        var attempts = 0;
        var timer = setInterval(function() {
            attempts += 1;
            if (!window.APP || !APP.GLOBAL || typeof APP.GLOBAL.toastMsg !== 'function') {
                if (attempts >= 100) clearInterval(timer);
                return;
            }
            clearInterval(timer);
            if (APP.GLOBAL.__akOriginalToastMsg) return;
            APP.GLOBAL.__akOriginalToastMsg = APP.GLOBAL.toastMsg;
            APP.GLOBAL.toastMsg = function(message) {
                if (isPasswordErrorMessage(message)) {
                    try {
                        showPasswordErrorDialog(message);
                        return;
                    } catch(e) {}
                }
                return APP.GLOBAL.__akOriginalToastMsg.apply(this, arguments);
            };
        }, 100);
    }

    window.AKClientRuntimePatches = window.AKClientRuntimePatches || {};
    window.AKClientRuntimePatches.installLoginPasswordErrorPatch = installLoginPasswordErrorPatch;
})();
