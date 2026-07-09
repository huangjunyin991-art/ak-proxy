(function() {
    'use strict';

    var PATCHED_ATTR = 'data-ak-autofill-guard';
    var PASSWORD_SELECTOR = 'input[type="password"]';
    var ROUTE_POLL_MS = 700;
    var syncTimer = null;
    var observer = null;
    var lastRouteKey = '';

    var TEXTLIKE_TYPES = {
        '': true,
        text: true,
        tel: true,
        email: true,
        number: true,
        url: true,
        search: true
    };

    var MANAGED_ATTRS = [
        'autocomplete',
        'autocapitalize',
        'autocorrect',
        'spellcheck',
        'data-lpignore',
        'data-1p-ignore',
        'data-bwignore'
    ];

    function currentRouteKey() {
        try {
            return String(window.location.pathname || '').toLowerCase() + '|' + String(window.location.search || '');
        } catch (e) {}
        return '';
    }

    function isLoginPage() {
        try {
            return String(window.location.pathname || '').toLowerCase().indexOf('/pages/account/login.html') >= 0;
        } catch (e) {}
        return false;
    }

    function isElement(node) {
        return !!(node && node.nodeType === 1);
    }

    function eachMatch(root, selector, callback) {
        if (!isElement(root) && root !== document) return;
        try {
            if (isElement(root) && root.matches && root.matches(selector)) {
                callback(root);
            }
        } catch (e) {}
        var nodes = [];
        try {
            nodes = root.querySelectorAll ? root.querySelectorAll(selector) : [];
        } catch (e) {
            nodes = [];
        }
        for (var i = 0; i < nodes.length; i++) {
            callback(nodes[i]);
        }
    }

    function rememberOriginalAttr(node, attrName) {
        if (!isElement(node)) return;
        var bag = node.__akAutofillGuardOriginalAttrs;
        if (!bag) {
            bag = {};
            node.__akAutofillGuardOriginalAttrs = bag;
        }
        if (!Object.prototype.hasOwnProperty.call(bag, attrName)) {
            bag[attrName] = node.hasAttribute(attrName) ? node.getAttribute(attrName) : null;
        }
    }

    function setManagedAttr(node, attrName, attrValue) {
        if (!isElement(node)) return;
        rememberOriginalAttr(node, attrName);
        if (attrValue == null) {
            node.removeAttribute(attrName);
        } else {
            node.setAttribute(attrName, String(attrValue));
        }
        node.setAttribute(PATCHED_ATTR, '1');
    }

    function restorePatchedNode(node) {
        if (!isElement(node)) return;
        var bag = node.__akAutofillGuardOriginalAttrs;
        if (bag && typeof bag === 'object') {
            for (var key in bag) {
                if (!Object.prototype.hasOwnProperty.call(bag, key)) continue;
                if (bag[key] == null) {
                    node.removeAttribute(key);
                } else {
                    node.setAttribute(key, bag[key]);
                }
            }
        }
        try {
            delete node.__akAutofillGuardOriginalAttrs;
        } catch (e) {
            node.__akAutofillGuardOriginalAttrs = null;
        }
        node.removeAttribute(PATCHED_ATTR);
    }

    function restorePatchedNodes(root) {
        eachMatch(root || document, '[' + PATCHED_ATTR + '="1"]', restorePatchedNode);
    }

    function isPasswordInput(node) {
        if (!isElement(node) || String(node.tagName || '').toLowerCase() !== 'input') return false;
        return String(node.type || '').toLowerCase() === 'password';
    }

    function isTextLikeInput(node) {
        if (!isElement(node) || String(node.tagName || '').toLowerCase() !== 'input') return false;
        var type = String(node.type || '').toLowerCase();
        return !!TEXTLIKE_TYPES[type];
    }

    function isEligibleInput(node) {
        return !!(isElement(node) && !node.disabled && String(node.type || '').toLowerCase() !== 'hidden');
    }

    function findGroupContainer(passwordInput) {
        if (!isPasswordInput(passwordInput)) return null;
        var explicit = passwordInput.form
            || passwordInput.closest('form, .van-form, .van-cell-group, .el-form, .dialog, .popup, .modal, .sheet, .input-group, .form-box, .card');
        if (explicit) return explicit;
        var cursor = passwordInput.parentElement;
        while (cursor && cursor !== document.body && cursor !== document.documentElement) {
            try {
                var inputCount = cursor.querySelectorAll ? cursor.querySelectorAll('input').length : 0;
                if (inputCount > 0 && inputCount <= 8) return cursor;
            } catch (e) {}
            cursor = cursor.parentElement;
        }
        return passwordInput.parentElement || null;
    }

    function collectInputGroup(container, passwordInput) {
        var result = [];
        var seen = [];
        function push(node) {
            if (!node || !isElement(node)) return;
            if (seen.indexOf(node) >= 0) return;
            seen.push(node);
            result.push(node);
        }
        if (container && container.querySelectorAll) {
            var inputs = container.querySelectorAll('input');
            for (var i = 0; i < inputs.length; i++) {
                push(inputs[i]);
            }
        }
        push(passwordInput);
        return result.filter(isEligibleInput);
    }

    function patchInput(input, isPassword) {
        if (!isEligibleInput(input)) return;
        setManagedAttr(input, 'autocomplete', isPassword ? 'new-password' : 'off');
        setManagedAttr(input, 'autocapitalize', 'off');
        setManagedAttr(input, 'autocorrect', 'off');
        setManagedAttr(input, 'spellcheck', 'false');
        setManagedAttr(input, 'data-lpignore', 'true');
        setManagedAttr(input, 'data-1p-ignore', 'true');
        setManagedAttr(input, 'data-bwignore', 'true');
    }

    function patchPasswordGroup(passwordInput) {
        if (!isPasswordInput(passwordInput) || !isEligibleInput(passwordInput)) return;
        var container = findGroupContainer(passwordInput);
        if (container && String(container.tagName || '').toLowerCase() === 'form') {
            setManagedAttr(container, 'autocomplete', 'off');
        }
        var groupInputs = collectInputGroup(container, passwordInput);
        for (var i = 0; i < groupInputs.length; i++) {
            var input = groupInputs[i];
            if (isPasswordInput(input)) {
                patchInput(input, true);
            } else if (isTextLikeInput(input)) {
                patchInput(input, false);
            }
        }
    }

    function syncPageAutofillState() {
        lastRouteKey = currentRouteKey();
        if (isLoginPage()) {
            restorePatchedNodes(document);
            return;
        }
        eachMatch(document, PASSWORD_SELECTOR, patchPasswordGroup);
    }

    function scheduleSync() {
        if (syncTimer) return;
        syncTimer = setTimeout(function() {
            syncTimer = null;
            syncPageAutofillState();
        }, 0);
    }

    function installRouteHooks() {
        if (window.__AKNonLoginAutofillRouteHooksInstalled) return;
        window.__AKNonLoginAutofillRouteHooksInstalled = true;

        try {
            var originalPushState = history.pushState;
            if (typeof originalPushState === 'function' && !originalPushState.__akAutofillWrapped) {
                var wrappedPushState = function() {
                    var result = originalPushState.apply(history, arguments);
                    scheduleSync();
                    return result;
                };
                wrappedPushState.__akAutofillWrapped = true;
                history.pushState = wrappedPushState;
            }
        } catch (e) {}

        try {
            var originalReplaceState = history.replaceState;
            if (typeof originalReplaceState === 'function' && !originalReplaceState.__akAutofillWrapped) {
                var wrappedReplaceState = function() {
                    var result = originalReplaceState.apply(history, arguments);
                    scheduleSync();
                    return result;
                };
                wrappedReplaceState.__akAutofillWrapped = true;
                history.replaceState = wrappedReplaceState;
            }
        } catch (e) {}

        try {
            window.addEventListener('popstate', scheduleSync, true);
            window.addEventListener('hashchange', scheduleSync, true);
        } catch (e) {}

        setInterval(function() {
            var nextRouteKey = currentRouteKey();
            if (nextRouteKey !== lastRouteKey) {
                scheduleSync();
            }
        }, ROUTE_POLL_MS);
    }

    function installObserver() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var mutation = mutations[i];
                if (mutation.type === 'childList') {
                    if ((mutation.addedNodes && mutation.addedNodes.length) || (mutation.removedNodes && mutation.removedNodes.length)) {
                        scheduleSync();
                        return;
                    }
                    continue;
                }
                if (mutation.type === 'attributes') {
                    scheduleSync();
                    return;
                }
            }
        });
        try {
            observer.observe(document.documentElement || document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['type', 'autocomplete', 'name', 'placeholder']
            });
        } catch (e) {}
    }

    function installNonLoginAutofillPatch() {
        if (window.__AKNonLoginAutofillPatchInstalled) return;
        window.__AKNonLoginAutofillPatchInstalled = true;
        lastRouteKey = currentRouteKey();
        installRouteHooks();
        installObserver();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scheduleSync, { once: true });
        } else {
            scheduleSync();
        }
    }

    window.AKClientRuntimePatches = window.AKClientRuntimePatches || {};
    window.AKClientRuntimePatches.installNonLoginAutofillPatch = installNonLoginAutofillPatch;
})();
