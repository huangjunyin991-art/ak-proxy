(function() {
    'use strict';

    var PASSWORD_ERROR_COUNTDOWN_SECONDS = 5;
    var LOGIN_SUBMIT_BLOCK_MS = PASSWORD_ERROR_COUNTDOWN_SECONDS * 1000;
    var lastLoginSubmitAt = 0;

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

    function getCurrentLoginPassword() {
        try {
            if (window._vue && window._vue.form) {
                return String(window._vue.form.password || '');
            }
        } catch(e) {}
        try {
            var input = document.querySelector('input[type="password"], input[name="password"]');
            return input ? String(input.value || '') : '';
        } catch(e) {}
        return '';
    }

    function getCurrentLoginAccount() {
        try {
            if (window._vue && window._vue.form) {
                return String(window._vue.form.account || '').trim();
            }
        } catch(e) {}
        try {
            var input = document.querySelector('input[name="account"], input[name="username"], input[type="text"]');
            return input ? String(input.value || '').trim() : '';
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
            var input = document.querySelector('input[name="account"], input[name="username"], input[type="text"]');
            if (input) {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch(e) {}
    }

    function resetLoginSubmitThrottle() {
        lastLoginSubmitAt = 0;
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
                '<button type="button" id="ak-login-use-account-hint" data-account="' + escapeHtml(suggestedAccount) + '" style="margin-top:8px;width:100%;height:30px;border:0;border-radius:4px;background:#d93025;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">使用该账号</button>' +
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

    function installUseAccountHintHandler() {
        var button = document.getElementById('ak-login-use-account-hint');
        if (!button || button.__akAccountHintBound) return;
        button.__akAccountHintBound = true;
        button.onclick = function() {
            setCurrentLoginAccount(button.getAttribute('data-account') || '');
            resetLoginSubmitThrottle();
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
        if (hintAnchorButton && hintAnchorButton.parentNode) {
            hintAnchorButton.parentNode.insertBefore(hintSlot, hintAnchorButton);
        }
        fetchAccountHint(typedAccount).then(function(hint) {
            try {
                var slot = document.getElementById('ak-login-account-hint-slot');
                if (!slot || !hint || !hint.suggested_account) return;
                slot.innerHTML = renderAccountHint(typedAccount, String(hint.suggested_account || ''));
                installUseAccountHintHandler();
            } catch(e) {}
        });
        var button = document.getElementById('ak-login-password-error-ok');
        var remaining = PASSWORD_ERROR_COUNTDOWN_SECONDS;
        var timer = setInterval(function() {
            remaining -= 1;
            if (!button || !button.parentNode) {
                clearInterval(timer);
                return;
            }
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
                closeDialog(overlay);
            };
        }, 1000);
    }

    function installLoginPasswordErrorPatch() {
        if (!isLoginPage() || window.__AKLoginPasswordErrorPatchInstalled) return;
        window.__AKLoginPasswordErrorPatchInstalled = true;
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
