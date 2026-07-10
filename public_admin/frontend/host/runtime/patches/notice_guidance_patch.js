(function() {
    'use strict';

    var ROUTE_POLL_MS = 700;
    var observer = null;
    var lastRouteKey = '';
    var latestResult = null;
    var latestNoticeKey = '';
    var installedNetworkHooks = false;
    var observerApplyTimer = 0;

    function isNoticeDetailPage() {
        try {
            return String(window.location.pathname || '').toLowerCase() === '/pages/subpages/last.notice.detail.html';
        } catch (e) {}
        return false;
    }

    function currentRouteKey() {
        try {
            return String(window.location.pathname || '').toLowerCase() + '|' + String(window.location.search || '') + '|' + String(window.location.hash || '');
        } catch (e) {}
        return '';
    }

    function normalizeText(value) {
        return String(value == null ? '' : value)
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t\r\f\v]+/g, ' ')
            .trim();
    }

    function safeParseJson(text) {
        var raw = String(text == null ? '' : text).trim();
        if (!raw || raw.charAt(0) !== '{') return null;
        try {
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {}
        return null;
    }

    function logWarn(message, extra) {
        try {
            if (extra === undefined) {
                console.warn('[AKNoticeGuidancePatch]', message);
                return;
            }
            console.warn('[AKNoticeGuidancePatch]', message, extra);
        } catch (e) {}
    }

    function getNoticeService() {
        try {
            return window.AKClientRuntimeNotices || null;
        } catch (e) {}
        return null;
    }

    function clearStaleHints(currentKey) {
        var nodes = [];
        try {
            nodes = document.querySelectorAll('[data-ak-guided-sale-hint="1"]');
        } catch (e) {
            nodes = [];
        }
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!node) continue;
            if (currentKey && node.getAttribute('data-ak-notice-key') === currentKey) continue;
            if (node.parentNode) node.parentNode.removeChild(node);
        }
    }

    function chooseAnchorElement(targetLine) {
        if (!targetLine) return null;
        var selectors = 'p, div, li, article, section, span';
        var candidates = [];
        try {
            candidates = document.querySelectorAll(selectors);
        } catch (e) {
            candidates = [];
        }
        var best = null;
        var bestScore = Number.MAX_SAFE_INTEGER;
        var normalizedTarget = normalizeText(targetLine);
        for (var i = 0; i < candidates.length; i++) {
            var node = candidates[i];
            if (!node || node.getAttribute('data-ak-guided-sale-hint') === '1') continue;
            var text = normalizeText(node.textContent || '');
            if (!text || text.indexOf(normalizedTarget) < 0) continue;
            var score = Math.abs(text.length - normalizedTarget.length);
            if (text === normalizedTarget) score -= 1000;
            if (score < bestScore) {
                best = node;
                bestScore = score;
            }
        }
        if (!best) return null;
        var tag = String(best.tagName || '').toUpperCase();
        if (tag === 'SPAN' && best.parentElement) {
            var parentTag = String(best.parentElement.tagName || '').toUpperCase();
            if (parentTag === 'P' || parentTag === 'DIV' || parentTag === 'LI') return best.parentElement;
        }
        return best;
    }

    function removeIdsDeep(node) {
        if (!node || node.nodeType !== 1) return;
        node.removeAttribute('id');
        var children = node.querySelectorAll ? node.querySelectorAll('[id]') : [];
        for (var i = 0; i < children.length; i++) {
            children[i].removeAttribute('id');
        }
    }

    function buildHintElement(anchor, result) {
        var tagName = (anchor && anchor.tagName && /^(P|DIV|LI)$/i.test(anchor.tagName)) ? anchor.tagName : 'P';
        var note = document.createElement(tagName);
        if (anchor && anchor.nodeType === 1) {
            if (anchor.className) note.className = anchor.className;
            var style = anchor.getAttribute('style');
            if (style) note.setAttribute('style', style);
        }
        note.setAttribute('data-ak-guided-sale-hint', '1');
        note.setAttribute('data-ak-notice-key', result.noticeKey || '');
        removeIdsDeep(note);

        var templateChild = anchor && anchor.firstElementChild ? anchor.firstElementChild.cloneNode(false) : null;
        if (templateChild) {
            removeIdsDeep(templateChild);
            templateChild.innerHTML = result.hintHtml || '';
            note.appendChild(templateChild);
        } else {
            note.innerHTML = result.hintHtml || '';
        }
        return note;
    }

    function applyGuidedSaleHint(result) {
        if (!isNoticeDetailPage() || !result || !result.noticeKey) return false;
        clearStaleHints(result.noticeKey);
        var existingNodes = [];
        try {
            existingNodes = document.querySelectorAll('[data-ak-guided-sale-hint="1"]');
        } catch (e) {
            existingNodes = [];
        }
        for (var i = 0; i < existingNodes.length; i++) {
            if (existingNodes[i] && existingNodes[i].getAttribute('data-ak-notice-key') === result.noticeKey) {
                return true;
            }
        }
        var anchor = chooseAnchorElement(result.targetLine);
        if (!anchor || !anchor.parentNode) return false;
        var note = buildHintElement(anchor, result);
        if (!note) return false;
        if (anchor.nextSibling) {
            anchor.parentNode.insertBefore(note, anchor.nextSibling);
        } else {
            anchor.parentNode.appendChild(note);
        }
        return true;
    }

    function scheduleHintApply() {
        if (!latestResult || !isNoticeDetailPage()) return;
        if (applyGuidedSaleHint(latestResult)) return;
        setTimeout(function() {
            if (latestResult) applyGuidedSaleHint(latestResult);
        }, 80);
        setTimeout(function() {
            if (latestResult) applyGuidedSaleHint(latestResult);
        }, 300);
    }

    function handleNoticePayload(detailEnvelope) {
        if (!isNoticeDetailPage()) return;
        var service = getNoticeService();
        if (!service || typeof service.analyzeGuidedSaleNoticeEnvelope !== 'function') return;
        service.analyzeGuidedSaleNoticeEnvelope(detailEnvelope)
            .then(function(result) {
                if (!result || !result.noticeKey) return;
                latestResult = result;
                latestNoticeKey = result.noticeKey;
                scheduleHintApply();
            })
            .catch(function(error) {
                logWarn('分析公告详情失败', String(error && error.message || error || 'unknown'));
            });
    }

    function inspectResponsePayload(responseText) {
        if (!isNoticeDetailPage()) return;
        var payload = safeParseJson(responseText);
        if (!payload) return;
        var service = getNoticeService();
        if (!service || typeof service.extractNoticeDetail !== 'function') return;
        if (!service.extractNoticeDetail(payload)) return;
        handleNoticePayload(payload);
    }

    function installXhrHook() {
        if (!window.XMLHttpRequest) return;
        var originalOpen = XMLHttpRequest.prototype.open;
        if (!originalOpen || originalOpen.__akNoticeGuidanceWrapped) return;
        var wrappedOpen = function(method, url) {
            try {
                if (!this.__akNoticeGuidanceLoadBound) {
                    this.__akNoticeGuidanceLoadBound = true;
                    this.addEventListener('load', function() {
                        try {
                            if (!isNoticeDetailPage()) return;
                            if (this.status && this.status !== 200) return;
                            if (this.responseType && this.responseType !== 'text' && this.responseType !== '') return;
                            inspectResponsePayload(this.responseText || '');
                        } catch (e) {}
                    });
                }
            } catch (e2) {}
            return originalOpen.apply(this, arguments);
        };
        wrappedOpen.__akNoticeGuidanceWrapped = true;
        XMLHttpRequest.prototype.open = wrappedOpen;
    }

    function installFetchHook() {
        if (typeof window.fetch !== 'function' || window.fetch.__akNoticeGuidanceWrapped) return;
        var originalFetch = window.fetch;
        var wrappedFetch = function(input, init) {
            var promise = originalFetch.apply(this, arguments);
            promise.then(function(response) {
                try {
                    if (!isNoticeDetailPage() || !response || !response.ok) return;
                    response.clone().text().then(function(text) {
                        inspectResponsePayload(text);
                    }).catch(function() {});
                } catch (e) {}
            }).catch(function() {});
            return promise;
        };
        wrappedFetch.__akNoticeGuidanceWrapped = true;
        window.fetch = wrappedFetch;
    }

    function installNetworkHooks() {
        if (installedNetworkHooks) return;
        installedNetworkHooks = true;
        installXhrHook();
        installFetchHook();
    }

    function installRouteHooks() {
        if (window.__AKNoticeGuidanceRouteHooksInstalled) return;
        window.__AKNoticeGuidanceRouteHooksInstalled = true;
        function schedule() {
            if (!isNoticeDetailPage()) {
                clearStaleHints('');
                return;
            }
            scheduleHintApply();
        }
        try {
            var originalPushState = history.pushState;
            if (typeof originalPushState === 'function' && !originalPushState.__akNoticeGuidanceWrapped) {
                var wrappedPushState = function() {
                    var result = originalPushState.apply(history, arguments);
                    setTimeout(schedule, 0);
                    return result;
                };
                wrappedPushState.__akNoticeGuidanceWrapped = true;
                history.pushState = wrappedPushState;
            }
        } catch (e) {}
        try {
            var originalReplaceState = history.replaceState;
            if (typeof originalReplaceState === 'function' && !originalReplaceState.__akNoticeGuidanceWrapped) {
                var wrappedReplaceState = function() {
                    var result = originalReplaceState.apply(history, arguments);
                    setTimeout(schedule, 0);
                    return result;
                };
                wrappedReplaceState.__akNoticeGuidanceWrapped = true;
                history.replaceState = wrappedReplaceState;
            }
        } catch (e2) {}
        try {
            window.addEventListener('popstate', schedule, true);
            window.addEventListener('hashchange', schedule, true);
        } catch (e3) {}
        setInterval(function() {
            var nextRouteKey = currentRouteKey();
            if (nextRouteKey !== lastRouteKey) {
                lastRouteKey = nextRouteKey;
                schedule();
            }
        }, ROUTE_POLL_MS);
    }

    function installObserver() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(function() {
            if (!isNoticeDetailPage() || !latestResult || !latestNoticeKey) return;
            if (observerApplyTimer) return;
            observerApplyTimer = window.setTimeout(function() {
                observerApplyTimer = 0;
                if (latestResult) applyGuidedSaleHint(latestResult);
            }, 60);
        });
        try {
            observer.observe(document.documentElement || document.body, {
                subtree: true,
                childList: true
            });
        } catch (e) {}
    }

    function installNoticeGuidancePatch() {
        if (window.__AKNoticeGuidancePatchInstalled) return;
        window.__AKNoticeGuidancePatchInstalled = true;
        lastRouteKey = currentRouteKey();
        installNetworkHooks();
        installRouteHooks();
        installObserver();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scheduleHintApply, { once: true });
        } else {
            scheduleHintApply();
        }
    }

    window.AKClientRuntimePatches = window.AKClientRuntimePatches || {};
    window.AKClientRuntimePatches.installNoticeGuidancePatch = installNoticeGuidancePatch;
})();
