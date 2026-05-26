(function() {
    'use strict';

    var PASSWORD_ERROR_COUNTDOWN_SECONDS = 5;

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

    function escapeHtml(value) {
        var div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function closeDialog(overlay) {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function showPasswordErrorDialog(message) {
        var oldOverlay = document.getElementById('ak-login-password-error-overlay');
        if (oldOverlay) closeDialog(oldOverlay);
        var password = getCurrentLoginPassword();
        var overlay = document.createElement('div');
        overlay.id = 'ak-login-password-error-overlay';
        overlay.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,0.45);display:flex;align-items:flex-start;justify-content:center;padding:6px 4px;box-sizing:border-box;';
        overlay.innerHTML = '' +
            '<div style="width:100%;max-width:none;background:#fff;border-radius:2px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-family:Arial,Helvetica,sans-serif;color:#333;text-align:center;overflow:hidden;">' +
                '<div style="padding:20px 18px 8px;font-size:13px;font-weight:700;color:#111;">AK</div>' +
                '<div style="padding:6px 20px 8px;font-size:12px;color:#8a8a8a;line-height:1.8;">' + escapeHtml(message) + '</div>' +
                '<div style="padding:0 20px 12px;font-size:12px;color:#555;line-height:1.8;word-break:break-all;">当前输入的密码为：<span style="color:#d93025;font-weight:700;">' + escapeHtml(password) + '</span>，请确认后重试！</div>' +
                '<button type="button" id="ak-login-password-error-ok" disabled style="width:100%;height:48px;border:0;background:#fff;color:#9aa0a6;font-size:13px;cursor:not-allowed;border-top:1px solid rgba(0,0,0,.06);">确认(' + PASSWORD_ERROR_COUNTDOWN_SECONDS + 's)</button>' +
            '</div>';
        document.body.appendChild(overlay);
        var button = document.getElementById('ak-login-password-error-ok');
        var remaining = PASSWORD_ERROR_COUNTDOWN_SECONDS;
        var timer = setInterval(function() {
            remaining -= 1;
            if (!button || !button.parentNode) {
                clearInterval(timer);
                return;
            }
            if (remaining > 0) {
                button.textContent = '确认(' + remaining + 's)';
                return;
            }
            clearInterval(timer);
            button.disabled = false;
            button.textContent = '确认';
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
